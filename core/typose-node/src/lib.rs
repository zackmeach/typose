//! napi-rs bindings for `typose-core` (spec §2.2: thin, no logic). Every caller-controlled number arrives as an
//! `f64` and goes through `limits::int` before any conversion (plan C4).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsError, Task};
use napi_derive::napi;
use typose_core::budget::{self, NoSlot, Reservation, Slot, Work};
use typose_core::doc::DocError;
#[cfg(feature = "test-hooks")]
use typose_core::hooks;
use typose_core::image_resource::{self, Pending, Resources};
use typose_core::limits::{self, RANGES};
use typose_core::local::LocalRoute;
use typose_core::local::folder;
use typose_core::md::{self, Rendered};
use typose_core::pages::{self, LinePiece};
use typose_core::raw::Raw;
use typose_core::store::{self, cancellable};

mod csv;
pub mod config;
mod find;
mod source;
mod structured;

/// Progress is throttled to 10 Hz, except while a first screen of lines is still filling (spec §3.4).
const FIRST_SCREEN_LINES: u64 = 256;

/// A thrown error's `code` (protocol v1's typed errors).
pub enum Code {
    InvalidParams,
    NotFound,
    NotDirectory,
    PermissionDenied,
    Refused,
    Binary,
    Frozen,
    Stale,
    Io,
    Cancelled,
    NoDocument,
    Memory,
}

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        match self {
            Code::InvalidParams => "InvalidParams",
            Code::NotFound => "NotFound",
            Code::NotDirectory => "NotDirectory",
            Code::PermissionDenied => "PermissionDenied",
            Code::Refused => "Refused",
            Code::Binary => "Binary",
            Code::Frozen => "Frozen",
            Code::Stale => "Stale",
            Code::Io => "Io",
            Code::Cancelled => "Cancelled",
            Code::NoDocument => "NoDocument",
            Code::Memory => "Memory",
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
        DocError::Memory(_) => Code::Memory,
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

/// Whether `path` reaches a network share, judged without opening anything (`store::network`).
#[napi]
pub fn network_path(path: String) -> bool {
    typose_core::store::network(std::path::Path::new(&path))
}

/// Plan C1: sets the ledger's limit to a quarter of `totalmem` (Z34), the core host's `os.totalmem()`, and reserves
/// the pool of transient slots. Nothing opens until it's set.
#[napi]
pub fn set_budget(totalmem: f64) -> std::result::Result<(), Error<Code>> {
    let totalmem = int("totalmem", totalmem)?;
    budget::set_limit(totalmem / 4).map_err(|e| Error::new(Code::Memory, e.to_string()))
}

/// The renderer's page cache, reserved for it in the ledger (plan C1, spec §3.6's "renderer-side caches the core is
/// told about"). One renderer talks to a core host.
static RENDERER_CACHE: Mutex<Reservation> = Mutex::new(Reservation::none());

/// Plan C1: sets the renderer cache's reservation to `bytes`, growing or shrinking it. False when the ledger refuses
/// the growth; the reservation is then unchanged.
#[napi]
pub fn reserve_cache(bytes: f64) -> std::result::Result<bool, Error<Code>> {
    let bytes = int("bytes", bytes)?;
    let mut held = RENDERER_CACHE.lock().unwrap();
    let now = held.bytes();
    if bytes < now {
        held.shrink(now - bytes);
    } else if held.grow(bytes - now).is_err() {
        return Ok(false);
    }
    Ok(true)
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
    /// Plan C1: one page read's temporaries in Rust, and an open's.
    pub page_temp: u32,
    pub open_temp: u32,
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
        page_temp: pages::PAGE_TEMP as u32,
        open_temp: typose_core::raw::OPEN_TEMP as u32,
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
///
/// Plan C1: its temporaries take a page slot, which it waits for on the pool's thread, and keeps until the task drops,
/// after `resolve` has made its JS page from them.
pub struct Read {
    raw: Arc<Raw>,
    generation: u32,
    want: Want,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
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
            slot: None,
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
        Ok(cancellable(&self.cancel, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(over) => DocError::Memory(over),
            })?);
            match self.want {
                Want::Lines { start, count } => raw.page(generation, start, count),
                Want::Piece { line, offset } => raw.piece(generation, line, offset).map(|p| vec![p]),
            }
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

/// What a Markdown build made (plan: Rendered Markdown slice §2.1): its items, HTML text units and bytes, DOM nodes,
/// and generated note-label units, which the lens reserves for (§2.2).
#[napi(object)]
pub struct MdBuild {
    pub blocks: f64,
    pub units: f64,
    pub html_bytes: f64,
    pub nodes: f64,
    pub note_units: f64,
}

/// One top-level block of a Markdown build: its index, its first line and how many lines it runs over (Raw's), its
/// sanitized HTML, and a top-level heading's slug or a footnote definition's label. A block too large to render has
/// no HTML, and a `note` saying why.
#[napi(object)]
pub struct MdItem {
    pub block: f64,
    pub line: f64,
    pub lines: f64,
    pub html: String,
    pub slug: Option<String>,
    pub footnote: Option<String>,
    pub note: Option<String>,
}

#[napi(object)]
pub struct MdPage {
    pub items: Vec<MdItem>,
}

/// A generation's Markdown build, once `render` has finished one. Each generation has its own, so a build that ends
/// after a Reload or close never lands in the document's current one.
type Built = Arc<Mutex<Option<Rendered>>>;

/// A Markdown build as an async task (plan C5): it runs on libuv's thread pool and stops at its cancel flag, at the
/// read's next chunk or within 1,024 parser events. It keeps what it built in its generation's `Built`.
pub struct Render {
    raw: Arc<Raw>,
    built: Built,
    generation: u32,
    cancel: Arc<AtomicBool>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}

impl Task for Render {
    type Output = std::result::Result<Rendered, DocError>;
    type JsValue = MdBuild;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(cancellable(&self.cancel, || self.raw.render(self.generation)))
    }

    /// As `Read`'s: once the core host has cancelled a build, it never resolves, and what it built drops here.
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<MdBuild> {
        let output = if self.cancel.load(Ordering::Relaxed) { Err(DocError::Cancelled) } else { output };
        match output {
            Ok(rendered) => {
                let size = rendered.items().len() as f64;
                let (units, html_bytes) = (rendered.units() as f64, rendered.html_bytes() as f64);
                let (nodes, note_units) = (rendered.nodes() as f64, rendered.note_units() as f64);
                *self.built.lock().unwrap() = Some(rendered); // the build it replaces drops
                Ok(MdBuild { blocks: size, units, html_bytes, nodes, note_units })
            }
            Err(e) => Err(Error::from(JsError::from(doc_error(e)).into_unknown(env))),
        }
    }
}

/// A page of a Markdown build (spec §3.4's bounds, `Rendered::page`), read as `Read` reads a Raw page: in a page slot
/// (plan C1), which holds its copies of the items until the task drops.
pub struct MdRead {
    built: Built,
    current: u32,
    generation: u32,
    start: u64,
    count: u64,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}

impl Task for MdRead {
    type Output = std::result::Result<Vec<MdItem>, DocError>;
    type JsValue = MdPage;

    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(over) => DocError::Memory(over),
            })?);
            if self.generation != self.current {
                return Err(DocError::Stale { current: self.current, asked: self.generation });
            }
            let built = self.built.lock().unwrap();
            let rendered = built.as_ref().ok_or_else(|| {
                DocError::Invalid(format!("generation {} has no Markdown build: render it first", self.generation))
            })?;
            let start = usize::try_from(self.start).unwrap_or(usize::MAX);
            let page = rendered.page(start, self.count as usize);
            let label = |s: &Option<Box<str>>| s.as_deref().map(String::from);
            Ok(page
                .iter()
                .enumerate()
                .map(|(k, item)| MdItem {
                    block: (start + k) as f64,
                    line: item.line as f64,
                    lines: item.lines as f64,
                    html: item.html.to_string(),
                    slug: label(&item.slug),
                    footnote: label(&item.footnote),
                    note: item.note.map(|n| n.text().to_string()),
                })
                .collect())
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<MdPage> {
        let output = if self.cancel.load(Ordering::Relaxed) { Err(DocError::Cancelled) } else { output };
        match output {
            Ok(items) => Ok(MdPage { items }),
            Err(e) => Err(Error::from(JsError::from(doc_error(e)).into_unknown(env))),
        }
    }
}

const IMAGE_TASK_BYTES: u64 = (3 * pages::MAX_PATH_BYTES + 4096) as u64;

#[napi(object)]
pub struct ImagePrepared {
    pub id: f64,
    pub width: u32,
    pub height: u32,
    pub encoded_bytes: u32,
    pub pixel_bytes: u32,
}

/// Field order is deliberate: generation state drops before its last Raw Arc, charge drops last.
pub struct PrepareImage {
    pending: Pending,
    raw: Arc<Raw>,
    target: String,
    generation: u32,
    cancel: Arc<AtomicBool>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
    _charge: Reservation,
}

impl Task for PrepareImage {
    type Output = std::result::Result<typose_core::images::CanonicalImage, DocError>;
    type JsValue = ImagePrepared;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(image_resource::prepare(self.raw.document(), self.generation, &self.target, &self.cancel))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<ImagePrepared> {
        let output = output.and_then(|image| {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            image_resource::check_source(self.raw.document(), self.generation)?;
            self.pending.publish(image)
        });
        match output {
            Ok(metadata) => Ok(ImagePrepared {
                id: metadata.id as f64,
                width: metadata.width,
                height: metadata.height,
                encoded_bytes: metadata.encoded_bytes,
                pixel_bytes: metadata.pixel_bytes,
            }),
            Err(error) => Err(Error::from(JsError::from(doc_error(error)).into_unknown(env))),
        }
    }
}

pub struct ImageChunk {
    state: Arc<Resources>, // drop before Raw, including on cancellation/close
    raw: Arc<Raw>,
    generation: u32,
    id: u64,
    offset: usize,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
    _charge: Reservation,
}

impl Task for ImageChunk {
    type Output = std::result::Result<Vec<u8>, DocError>;
    type JsValue = Uint8Array;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(cancellable(&self.cancel, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|error| match error {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(error) => DocError::Memory(error),
            })?);
            image_resource::check_source(self.raw.document(), self.generation)?;
            let bytes = self.state.chunk(self.id, self.offset)?;
            image_resource::check_source(self.raw.document(), self.generation)?;
            Ok(bytes)
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Uint8Array> {
        let output = output.and_then(|bytes| {
            if self.cancel.load(Ordering::Relaxed) || !self.state.contains(self.id) {
                return Err(DocError::Cancelled);
            }
            image_resource::check_source(self.raw.document(), self.generation)?;
            Ok(bytes)
        });
        match output {
            Ok(bytes) => Ok(Uint8Array::new(bytes)), // Work::Page slot survives through this NAPI conversion
            Err(error) => Err(Error::from(JsError::from(doc_error(error)).into_unknown(env))),
        }
    }
}

/// Pays the native wrapper and its host UUID/entry garbage until finalization, including after release.
const SAVED_WRAPPER_BYTES: u64 = 16 * 1024;
#[cfg(feature = "test-hooks")]
static SAVED_WRAPPERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Session-only route authority. It never owns a Raw, Document, index or page payload.
#[napi]
pub struct SavedRoute {
    route: Option<LocalRoute>,
    // Remains charged while JS still holds even an empty wrapper; released only by Drop.
    _wrapper: Reservation,
}

#[napi(object)]
pub struct FolderEntry {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub hidden: bool,
}
#[napi(object)]
pub struct FolderPage {
    pub entries: Vec<FolderEntry>,
    pub cursor: Option<u32>,
}
#[napi(object)]
pub struct FolderContext {
    pub root: String,
    pub node: Option<String>,
    pub label: String,
    pub segments: Vec<String>,
}

/// No constructor: only an explicit selected-directory capture creates authority.
#[napi]
pub struct FolderRoot {
    state: Arc<folder::Folder>,
    // Empty JS wrappers remain paid after close, until NAPI finalizes them.
    _wrapper: Reservation,
}

#[napi]
impl FolderRoot {
    #[napi(factory)]
    pub fn capture(path: String, id: String) -> std::result::Result<Self, Error<Code>> {
        if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::new(Code::InvalidParams, "invalid root identity"));
        }
        let wrapper = Reservation::new(16 * 1024).map_err(|e| doc_error(DocError::Memory(e)))?;
        let state = folder::Folder::capture(std::path::Path::new(&path), &id).map_err(|e| {
            // Explicit CLI arrivals can then try manual-file policy, never after generic capability refusal.
            #[cfg(windows)]
            if matches!(&e,DocError::Io(io) if io.raw_os_error()==Some(267)) {
                return Error::new(Code::NotDirectory, "the selected path is not a directory");
            }
            doc_error(e)
        })?;
        Ok(Self { state: Arc::new(state), _wrapper: wrapper })
    }
    #[napi(getter)]
    pub fn label(&self) -> std::result::Result<String, Error<Code>> {
        Ok(self.state.info().map_err(doc_error)?.0)
    }
    #[napi(getter)]
    pub fn path(&self) -> std::result::Result<String, Error<Code>> {
        Ok(self.state.info().map_err(doc_error)?.1)
    }
    #[napi(getter)]
    pub fn identity(&self) -> std::result::Result<String, Error<Code>> {
        self.state.identity().map_err(doc_error)
    }
    #[napi(ts_return_type = "Promise<FolderPage>")]
    pub fn list(
        &self,
        node: f64,
        cursor: Option<f64>,
        hidden: bool,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ListFolder>, Error<Code>> {
        let node = int("start", node)?;
        if node >= folder::MAX_NODES as u64 {
            return Err(Error::new(Code::InvalidParams, "invalid folder node"));
        }
        let cursor = cursor
            .map(|x| {
                int("id", x).and_then(|n| {
                    u32::try_from(n).map_err(|_| Error::new(Code::InvalidParams, "invalid folder cursor"))
                })
            })
            .transpose()?;
        let charge = Reservation::new(folder::PAGE_WORK).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(ListFolder {
            state: self.state.clone(),
            node: node as u32,
            cursor,
            hidden,
            cancel: cancel.flag.clone(),
            _charge: charge,
        }))
    }
    /// A listed entry's path, for main's OS hand-off. It opens nothing.
    #[napi]
    pub fn entry_path(&self, node: f64) -> std::result::Result<String, Error<Code>> {
        let node = int("start", node)?;
        if node >= folder::MAX_NODES as u64 {
            return Err(Error::new(Code::InvalidParams, "invalid folder node"));
        }
        self.state.entry_path(node as u32).map_err(doc_error)
    }
    #[napi]
    pub fn open(&self, node: f64) -> std::result::Result<Doc, Error<Code>> {
        let node = int("start", node)?;
        if node >= folder::MAX_NODES as u64 {
            return Err(Error::new(Code::InvalidParams, "invalid folder node"));
        }
        let raw = self.state.open(node as u32).map_err(doc_error)?;
        Ok(Doc {
            images: None,
            raw: Some(Arc::new(raw)),
            built: Built::default(),
            csv: Arc::default(),
            find: Arc::default(),
            structured: Arc::default(),
        })
    }
    #[napi]
    pub fn close(&self) -> bool {
        self.state.close()
    }
}

pub struct ListFolder {
    state: Arc<folder::Folder>,
    node: u32,
    cursor: Option<u32>,
    hidden: bool,
    cancel: Arc<AtomicBool>,
    _charge: Reservation,
}
impl Task for ListFolder {
    type Output = std::result::Result<folder::Page, DocError>;
    type JsValue = FolderPage;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.state.list(self.node, self.cursor, self.hidden, &|| self.cancel.load(Ordering::Relaxed)))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<FolderPage> {
        let output = if self.cancel.load(Ordering::Relaxed) { Err(DocError::Cancelled) } else { output };
        match output {
            Ok(p) => Ok(FolderPage {
                entries: p
                    .entries
                    .into_iter()
                    .map(|e| FolderEntry { id: e.id, name: e.name, kind: e.kind.into(), hidden: e.hidden })
                    .collect(),
                cursor: p.cursor,
            }),
            Err(e) => Err(Error::from(JsError::from(doc_error(e)).into_unknown(env))),
        }
    }
}

#[napi]
impl SavedRoute {
    #[napi]
    pub fn open(&self) -> std::result::Result<Doc, Error<Code>> {
        let route = self.route.as_ref().ok_or_else(|| Error::new(Code::NoDocument, "the saved route was released"))?;
        let raw = Raw::open_saved(route).map_err(doc_error)?;
        Ok(Doc {
            images: None,
            raw: Some(Arc::new(raw)),
            built: Built::default(),
            csv: Arc::default(),
            find: Arc::default(),
            structured: Arc::default(),
        })
    }

    #[napi]
    pub fn release(&mut self) -> bool {
        self.route.take().is_some()
    }
}

impl Drop for SavedRoute {
    fn drop(&mut self) {
        #[cfg(feature = "test-hooks")]
        SAVED_WRAPPERS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// An open document in Raw. Offsets and sizes are exact numbers: `Raw::open` refuses files over 2^53 − 1 bytes.
/// `close` drops it at once; until then it lives as long as the JS object does.
#[napi]
pub struct Doc {
    images: Option<Arc<Resources>>,
    raw: Option<Arc<Raw>>,
    /// The current generation's Markdown build. Reload and close start a new one, and the old drops with its last task.
    built: Built,
    csv: Arc<csv::Owner>,
    find: Arc<find::Owner>,
    structured: Arc<structured::Owner>,
}

#[napi]
impl Doc {
    #[napi(factory)]
    pub fn open(path: String) -> std::result::Result<Doc, Error<Code>> {
        if path.is_empty() || path.contains('\0') || path.len() > pages::MAX_PATH_BYTES {
            let why =
                format!("path must be a non-empty string of at most {} bytes, without NUL", pages::MAX_PATH_BYTES);
            return Err(Error::new(Code::InvalidParams, why));
        }
        let raw = Raw::open(std::path::Path::new(&path)).map_err(doc_error)?;
        Ok(Doc {
            images: None,
            raw: Some(Arc::new(raw)),
            built: Built::default(),
            csv: Arc::default(),
            find: Arc::default(),
            structured: Arc::default(),
        })
    }

    fn raw(&self) -> std::result::Result<&Arc<Raw>, Error<Code>> {
        self.raw.as_ref().ok_or_else(|| Error::new(Code::NoDocument, "the document is closed"))
    }

    #[napi]
    pub fn bind_folder(&mut self, root: &FolderRoot) -> std::result::Result<bool, Error<Code>> {
        let raw = self.raw.as_mut().ok_or_else(|| Error::new(Code::NoDocument, "the document is closed"))?;
        let raw = Arc::get_mut(raw)
            .ok_or_else(|| Error::new(Code::Refused, "bind a folder only before document work starts"))?;
        raw.bind_folder(&root.state).map_err(doc_error)
    }

    #[napi(getter)]
    pub fn folder(&self) -> std::result::Result<Option<FolderContext>, Error<Code>> {
        let raw = self.raw()?;
        let Some((id, node, label, relative)) = raw.document().folder_scope() else { return Ok(None) };
        // A maximally fragmented path also allocates one String/array slot per two path units.
        let _temp =
            Reservation::new((16 * pages::MAX_PATH_BYTES) as u64).map_err(|e| doc_error(DocError::Memory(e)))?;
        let segments = relative.split('\\').map(str::to_owned).collect();
        Ok(Some(FolderContext { root: id.into(), node: node.map(|n| n.to_string()), label: label.into(), segments }))
    }

    #[napi(getter)]
    pub fn size(&self) -> std::result::Result<f64, Error<Code>> {
        Ok(self.raw()?.document().len() as f64)
    }

    #[napi(getter)]
    pub fn generation(&self) -> std::result::Result<u32, Error<Code>> {
        Ok(self.raw()?.document().generation())
    }

    /// Retained inactive tabs keep their store floor. This only changes cache policy; it performs no identity/path IO.
    #[napi]
    pub fn set_cache_active(&self, generation: f64, active: bool) -> std::result::Result<(), Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let document = self.raw()?.document();
        let current = document.generation();
        if generation != current {
            return Err(doc_error(DocError::Stale { current, asked: generation }));
        }
        document.store().set_cache_active(active);
        Ok(())
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

    /// Spec §4.1: `markdown` for a `.md` or `.markdown` file, else `text`.
    #[napi(getter)]
    pub fn format(&self) -> std::result::Result<String, Error<Code>> {
        let path = self.raw()?.document().path();
        Ok(if md::is_markdown(path) {
            "markdown"
        } else if csv::supported(path) {
            "csv"
        } else {
            structured::format(path).unwrap_or("text")
        }
        .into())
    }

    /// Local-derived documents require an explicit manual selection after a core restart loses this capability.
    #[napi(getter)]
    pub fn local_only(&self) -> std::result::Result<bool, Error<Code>> {
        Ok(self.raw()?.document().local_only())
    }

    /// Origin and generation are native-owned; unlike local links this also works for derived TXT/frozen sources.
    #[napi]
    pub fn save_route(&self, generation: f64) -> std::result::Result<SavedRoute, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let route = self.raw()?.document().saved_route(generation).map_err(doc_error)?;
        let wrapper = Reservation::new(SAVED_WRAPPER_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        #[cfg(feature = "test-hooks")]
        SAVED_WRAPPERS.fetch_add(1, Ordering::Relaxed);
        Ok(SavedRoute { route: Some(route), _wrapper: wrapper })
    }

    #[napi(getter)]
    pub fn path(&self) -> std::result::Result<String, Error<Code>> {
        let raw = self.raw()?;
        let _temp = Reservation::new((3 * pages::MAX_PATH_BYTES) as u64).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(raw.document().path().to_string_lossy().into_owned())
    }

    /// The local-link source must still be live and rendered in this generation. The target is already decoded.
    fn local_source(&self, generation: f64) -> std::result::Result<(&Arc<Raw>, u32), Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let raw = self.raw()?;
        let current = raw.document().generation();
        if generation != current {
            return Err(doc_error(DocError::Stale { current, asked: generation }));
        }
        if !md::is_markdown(raw.document().path()) {
            return Err(Error::new(Code::Refused, "local links require a Markdown source"));
        }
        if self.built.lock().unwrap().is_none() {
            return Err(Error::new(Code::InvalidParams, "render the Markdown build first"));
        }
        Ok((raw, generation))
    }

    // The host has parsed src exactly once. Native still validates the decoded target through image_route.
    #[napi(ts_return_type = "Promise<ImagePrepared>")]
    pub fn prepare_image(
        &mut self,
        generation: f64,
        target: String,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<PrepareImage>, Error<Code>> {
        let (raw, generation) = {
            let (raw, generation) = self.local_source(generation)?;
            (Arc::clone(raw), generation)
        };
        // Validate before the task is queued; resource route checks remain on its worker too.
        if target.is_empty() || target.len() > 32 << 10 || target.chars().any(char::is_control) {
            return Err(Error::new(
                Code::InvalidParams,
                "image target must be a decoded path of at most 32 KiB without controls",
            ));
        }
        let charge = Reservation::new(IMAGE_TASK_BYTES).map_err(|error| doc_error(DocError::Memory(error)))?;
        if self.images.is_none() {
            self.images = Some(Resources::new(generation).map_err(doc_error)?);
        }
        let state = self.images.as_ref().unwrap();
        let pending = state.reserve(Arc::clone(&cancel.flag)).map_err(doc_error)?;
        Ok(AsyncTask::new(PrepareImage {
            pending,
            raw,
            target,
            generation,
            cancel: Arc::clone(&cancel.flag),
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
            _charge: charge,
        }))
    }

    #[napi(ts_return_type = "Promise<Uint8Array>")]
    pub fn image_chunk(
        &self,
        generation: f64,
        id: f64,
        offset: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ImageChunk>, Error<Code>> {
        let id = int("id", id)?; // u64/MAX_SAFE throughout; never a u32 cast
        let offset = int("offset", offset)?;
        if offset > typose_core::images::MAX_CANONICAL as u64 || !offset.is_multiple_of(image_resource::CHUNK as u64) {
            return Err(Error::new(Code::InvalidParams, "image offset must be aligned to 256 KiB within 8 MiB"));
        }
        let (raw, generation) = self.local_source(generation)?;
        let state = self
            .images
            .as_ref()
            .filter(|state| state.generation() == generation && state.contains(id))
            .ok_or_else(|| Error::new(Code::Refused, "the image resource was released"))?;
        let charge = Reservation::new(4096).map_err(|error| doc_error(DocError::Memory(error)))?;
        Ok(AsyncTask::new(ImageChunk {
            state: Arc::clone(state),
            raw: Arc::clone(raw),
            generation,
            id,
            offset: offset as usize,
            cancel: Arc::clone(&cancel.flag),
            slot: None,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
            _charge: charge,
        }))
    }

    #[napi]
    pub fn release_image(&self, generation: f64, id: f64) -> std::result::Result<bool, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let id = int("id", id)?;
        Ok(self.images.as_ref().filter(|state| state.generation() == generation).is_some_and(|state| state.release(id)))
    }

    // Non-exported method inside impl Doc. Called before replacing/dropping raw.
    fn clear_images(&mut self) {
        if let Some(state) = self.images.take() {
            state.close();
        }
    }

    /// Normalizes a decoded route and checks the source identity, without opening the target.
    #[napi]
    pub fn local_path(&self, generation: f64, target: String) -> std::result::Result<String, Error<Code>> {
        let (raw, generation) = self.local_source(generation)?;
        let _temp = Reservation::new((3 * pages::MAX_PATH_BYTES) as u64).map_err(|e| doc_error(DocError::Memory(e)))?;
        let route = raw.document().local_path(generation, &target).map_err(doc_error)?;
        Ok(route.path().to_string_lossy().into_owned())
    }

    /// `local_path` for any extension: where a linked program or script is, for the hand-off sheet. It opens nothing.
    /// `href` must be a link of this generation's build (`target` is the host's decoding of it): never a page's choice.
    #[napi]
    pub fn link_path(&self, generation: f64, target: String, href: String) -> std::result::Result<String, Error<Code>> {
        let (raw, generation) = self.local_source(generation)?;
        if !self.built.lock().unwrap().as_ref().is_some_and(|built| built.links_to(&href)) {
            return Err(Error::new(Code::Refused, "the document doesn't link to this target"));
        }
        let _temp = Reservation::new((3 * pages::MAX_PATH_BYTES) as u64).map_err(|e| doc_error(DocError::Memory(e)))?;
        let route = raw.document().link_path(generation, &target).map_err(doc_error)?;
        Ok(route.path().to_string_lossy().into_owned())
    }

    /// Opens only a supported local document through its parent's held capability. No pathname fallback.
    #[napi]
    pub fn open_local(&self, generation: f64, target: String) -> std::result::Result<Doc, Error<Code>> {
        let (raw, generation) = self.local_source(generation)?;
        let next = raw.open_local(generation, &target).map_err(doc_error)?;
        Ok(Doc {
            images: None,
            raw: Some(Arc::new(next)),
            built: Built::default(),
            csv: Arc::default(),
            find: Arc::default(),
            structured: Arc::default(),
        })
    }

    /// Ctrl+R (spec §3.1): the same path at the next generation, which `startIndex` then indexes. Every page and
    /// token of the old generation is refused from now on (`Stale`). If the open fails, nothing changes.
    #[napi]
    pub fn reload(&mut self) -> std::result::Result<(), Error<Code>> {
        let next = self.raw()?.reload().map_err(doc_error)?;
        self.csv.close();
        self.structured.close();
        self.structured = Arc::default();
        self.find.close();
        self.csv = Arc::default();
        self.clear_images();
        self.raw = Some(Arc::new(next));
        self.built = Built::default();
        Ok(())
    }

    #[napi]
    pub fn reload_in_folder(&mut self, root: &FolderRoot) -> std::result::Result<(), Error<Code>> {
        let next = self.raw()?.reload_in_folder(Some(&root.state)).map_err(doc_error)?;
        self.csv.close();
        self.structured.close();
        self.structured = Arc::default();
        self.find.close();
        self.csv = Arc::default();
        self.clear_images();
        self.raw = Some(Arc::new(next));
        self.built = Built::default();
        Ok(())
    }

    /// Plan C6: drops the document. Its file handle closes once the index job and the page reads that share it have
    /// stopped, which the core host cancels first. Every later call is `NoDocument`.
    #[napi]
    pub fn close(&mut self) {
        self.csv.close();
        self.structured.close();
        self.find.close();
        self.clear_images();
        self.raw = None;
        self.built = Built::default();
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
            // The flag also ends the wait for an index slot (plan C1), if the pool has none free.
            let flag = cancel.clone();
            let result = cancellable(&flag, || {
                raw.index(|p| {
                    let filling_first_screen = sent_lines < FIRST_SCREEN_LINES && p.lines > sent_lines;
                    if p.done || filling_first_screen || last.is_none_or(|t| t.elapsed() >= Duration::from_millis(100))
                    {
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
                })
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

    /// Plan (Rendered Markdown slice) §2.1: builds generation `gen` as Markdown blocks, up to 8 MiB of source, and keeps
    /// them for `mdPage`, in place of any build before. Rejects with `Stale`, `Frozen`, `Refused` (over 8 MiB),
    /// `Memory` (nothing stays charged) or `Cancelled`.
    #[napi(ts_return_type = "Promise<MdBuild>")]
    pub fn render(&self, generation: f64, cancel: &Cancel) -> std::result::Result<AsyncTask<Render>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        Ok(AsyncTask::new(Render {
            raw: self.raw()?.clone(),
            built: self.built.clone(),
            generation,
            cancel: cancel.flag.clone(),
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }

    /// Up to `count` blocks from block `start` of generation `gen`'s Markdown build, within spec §3.4's bounds. `Stale`
    /// for an old generation; `InvalidParams` before `render` has built this one. A freeze doesn't stop it: the build
    /// came from one verified read, and the lens keeps what it shows (plan: Rendered Markdown slice §2.2).
    #[napi(ts_return_type = "Promise<MdPage>")]
    pub fn md_page(
        &self,
        generation: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<MdRead>, Error<Code>> {
        let (generation, start, count) = (int("gen", generation)? as u32, int("start", start)?, int("count", count)?);
        Ok(AsyncTask::new(MdRead {
            built: self.built.clone(),
            current: self.raw()?.document().generation(),
            generation,
            start,
            count,
            cancel: cancel.flag.clone(),
            slot: None,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }

    /// A decoded fragment's source line in this generation's held Markdown build. No file-system access.
    #[napi]
    pub fn heading_line(&self, generation: f64, fragment: String) -> std::result::Result<Option<u32>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        if fragment.len() > 32 << 10 || fragment.chars().any(char::is_control) {
            return Err(Error::new(Code::InvalidParams, "fragment must be at most 32 KiB, without control characters"));
        }
        let current = self.raw()?.document().generation();
        if generation != current {
            return Err(doc_error(DocError::Stale { current, asked: generation }));
        }
        let built = self.built.lock().unwrap();
        let rendered =
            built.as_ref().ok_or_else(|| Error::new(Code::InvalidParams, "render the Markdown build first"))?;
        Ok(rendered.heading_line(&fragment))
    }
}

/// The test-hooks addon's own calls (plan m8), absent from the release addon.
#[cfg(feature = "test-hooks")]
pub mod test_hooks {
    use super::*;

    #[napi(object)]
    pub struct SavedStats {
        pub wrappers: f64,
        pub wrapper_bytes: f64,
    }

    /// Includes released wrappers that remain reachable or await finalization, not only logical tickets.
    #[napi]
    pub fn saved_stats() -> SavedStats {
        let wrappers = SAVED_WRAPPERS.load(Ordering::Relaxed) as u64;
        SavedStats { wrappers: wrappers as f64, wrapper_bytes: (wrappers * SAVED_WRAPPER_BYTES) as f64 }
    }

    #[napi]
    pub fn saved_route_bytes(route: &SavedRoute) -> f64 {
        route.route.as_ref().map_or(0, LocalRoute::charged) as f64
    }

    /// The ledger (plan C1): its limit, what's charged now and at most, the pool's share, the renderer cache's.
    #[napi(object)]
    pub struct Ledger {
        pub limit: f64,
        pub used: f64,
        pub high: f64,
        pub pool: f64,
        pub renderer_cache: f64,
    }

    /// What's alive in this core (plan C6's "0 jobs, 0 tasks and 0 handles"), the longest a chunk read's delay has
    /// actually waited since the delay was set (`delay_ms`, plan C5), and the ledger.
    #[napi(object)]
    pub struct DebugStats {
        pub jobs: u32,
        pub tasks: u32,
        pub handles: u32,
        pub delay_ms: f64,
        pub ledger: Ledger,
    }

    #[napi]
    pub fn debug_stats() -> DebugStats {
        let count = |c| hooks::count(c) as u32;
        let delay_ms = hooks::slowest_delay_ms();
        let t = budget::totals();
        let renderer_cache = RENDERER_CACHE.lock().unwrap().bytes() as f64;
        let ledger = Ledger {
            limit: t.limit as f64,
            used: t.used as f64,
            high: t.high as f64,
            pool: t.pool as f64,
            renderer_cache,
        };
        DebugStats {
            jobs: count(&hooks::JOBS),
            tasks: count(&hooks::TASKS),
            handles: count(&hooks::HANDLES),
            delay_ms,
            ledger,
        }
    }

    /// One document's charges, itemized (plan C1, C6), and whether its line checkpoints stopped at the limit.
    #[napi(object)]
    pub struct Charges {
        pub hashes: f64,
        pub checkpoints: f64,
        pub cache: f64,
        pub metadata: f64,
        pub total: f64,
        pub lines_stopped: bool,
    }

    #[napi]
    pub fn doc_charges(doc: &Doc) -> std::result::Result<Charges, Error<Code>> {
        let raw = doc.raw()?;
        let c = raw.charges();
        // The held Markdown build's reservation. Raw's itemization does not include it; the sum does.
        let rendered = doc.built.lock().unwrap().as_ref().map(|r| r.charged()).unwrap_or(0);
        let images = doc.images.as_ref().map(|resources| resources.charged()).unwrap_or(0);
        let csv = doc.csv.charged();
        let find = doc.find.charged();
        let structured = doc.structured.charged();
        let [hashes, checkpoints, cache, metadata, total] =
            [c.hashes, c.checkpoints, c.cache, c.metadata, c.total() + rendered + images + csv + find + structured]
                .map(|n| n as f64);
        Ok(Charges { hashes, checkpoints, cache, metadata, total, lines_stopped: raw.lines_stopped() })
    }

    /// Starts the ledger's high-water mark again from what's charged now (plan C1's exhaustion test, per cycle).
    #[napi]
    pub fn reset_high() {
        budget::reset_high();
    }

    /// The test-hooks build's budget override (plan C1's exhaustion test): the ledger's limit, in bytes.
    #[napi]
    pub fn set_limit(bytes: f64) -> std::result::Result<(), Error<Code>> {
        budget::set_limit(int("bytes", bytes)?).map_err(|e| Error::new(Code::Memory, e.to_string()))
    }

    /// Plan C5's per-read delay: every chunk read from disk waits `ms` first.
    #[napi]
    pub fn set_read_delay(ms: f64) -> std::result::Result<(), Error<Code>> {
        hooks::set_read_delay(ms).map_err(|why| Error::new(Code::InvalidParams, why))
    }
}

impl Drop for Doc {
    fn drop(&mut self) {
        self.csv.close();
        self.structured.close();
        self.find.close();
        self.clear_images();
    }
}
