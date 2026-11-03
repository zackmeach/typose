//! Generation-owned span indexes and bounded structured pages.
use super::*;
use std::sync::atomic::{AtomicU32, AtomicU64};
use typose_core::{json, jsonl, structured as core_structured};

pub(super) fn format(path: &std::path::Path) -> Option<&'static str> {
    match path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("json" | "jsonc") => Some("json"),
        Some("jsonl" | "ndjson") => Some("jsonl"),
        Some("yaml" | "yml") => Some("yaml"),
        _ => None,
    }
}
pub struct Entry {
    generation: u32,
    revision: u32,
    format: &'static str,
    tree: Option<core_structured::JsonTree>,
    jsonl: Option<Arc<jsonl::Index>>,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
pub(super) struct Owner {
    state: Mutex<Option<Arc<Entry>>>,
    next: AtomicU32,
    epoch: AtomicU64,
    closed: AtomicBool,
    pending: Mutex<Option<Arc<AtomicBool>>>,
}
impl Owner {
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.epoch.fetch_add(1, Ordering::Relaxed);
        if let Some(flag) = self.pending.lock().unwrap().take() {
            flag.store(true, Ordering::Relaxed);
        }
        if let Some(entry) = self.state.lock().unwrap().take() {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
    #[cfg(feature = "test-hooks")]
    pub(super) fn charged(&self) -> u64 {
        self.state.lock().unwrap().as_ref().map_or(0, |entry| {
            entry.tree.as_ref().map_or(0, |tree| tree.charged())
                + entry.jsonl.as_ref().map_or(0, |index| index.charged())
        })
    }
    fn current(&self, entry: &Arc<Entry>) -> bool {
        !self.closed.load(Ordering::Relaxed)
            && self.state.lock().unwrap().as_ref().is_some_and(|e| Arc::ptr_eq(e, entry))
    }
}
#[napi(object)]
pub struct StructuredNode {
    pub ordinal: f64,
    pub kind: String,
    pub span: Span,
    pub key: Option<String>,
    pub key_span: Option<Span>,
    pub key_more: bool,
    pub text: String,
    pub more: bool,
    pub container: Option<u32>,
    pub children: Option<f64>,
    pub duplicate: bool,
}
#[napi(object)]
pub struct StructuredProblem {
    pub kind: String,
    pub count: f64,
    pub message: String,
    pub first: Span,
    pub line: Option<f64>,
    pub column: Option<f64>,
}
#[napi(object)]
pub struct StructuredInfo {
    pub revision: u32,
    pub format: String,
    pub status: String,
    pub reason: Option<String>,
    pub parsed_as: Option<String>,
    pub root: Option<StructuredNode>,
    pub rows: Option<f64>,
    pub parsed: Option<f64>,
    pub failed: Option<f64>,
    pub blank: Option<f64>,
    pub done: bool,
    pub problems: Vec<StructuredProblem>,
    pub columns: Option<f64>,
    pub table_off: Option<String>,
    pub schema: Option<String>,
}
#[napi(object)]
pub struct StructuredChildren {
    pub nodes: Vec<StructuredNode>,
    pub next: Option<f64>,
}
fn node(
    raw: &Raw,
    generation: u32,
    index: &json::JsonIndex,
    ordinal: u64,
    child: json::Child,
    duplicate: bool,
) -> std::result::Result<StructuredNode, DocError> {
    let container = child.container;
    let children = container.and_then(|id| index.containers.get(id as usize)).map(|c| c.children as f64);
    let key = child
        .key
        .map(|key| {
            raw.document().verified(generation, |store| jsonl::read_string_encoding(store, key, raw.source_encoding()))
        })
        .transpose()?;
    let is_container = container.is_some();
    let bytes = if is_container {
        Vec::new()
    } else {
        raw.document().read(generation, child.value.start, child.value.end.min(child.value.start + 4096))?
    };
    let (slice, used) = typose_core::encoding::decode_prefix(
        &bytes,
        raw.source_encoding(),
        child.value.start,
        bytes.len(),
        bytes.len() as u64 == child.value.end - child.value.start,
    );
    Ok(StructuredNode {
        ordinal: ordinal as f64,
        kind: match child.kind {
            json::Kind::Object => "object",
            json::Kind::Array => "array",
            json::Kind::String => "string",
            json::Kind::Number => "number",
            json::Kind::True | json::Kind::False => "boolean",
            json::Kind::Null => "null",
        }
        .into(),
        span: span(child.value),
        key,
        key_span: child.key.map(span),
        key_more: child.key.is_some_and(|key| key.end - key.start > 4096),
        text: slice.text,
        more: !is_container && (used as u64) < child.value.end - child.value.start,
        container,
        children,
        duplicate,
    })
}
fn describe(raw: &Raw, entry: &Entry) -> std::result::Result<StructuredInfo, DocError> {
    let mut info = StructuredInfo {
        revision: entry.revision,
        format: entry.format.into(),
        status: "ready".into(),
        reason: None,
        parsed_as: None,
        root: None,
        rows: None,
        parsed: None,
        failed: None,
        blank: None,
        done: entry.format != "jsonl",
        problems: Vec::new(),
        columns: None,
        table_off: None,
        schema: None,
    };
    if let Some(tree) = &entry.tree {
        let index = &tree.index;
        info.parsed_as = Some(
            if index.trivia.comments + index.trivia.trailing_commas + index.trivia.nonfinite > 0
                || raw.document().path().extension().is_some_and(|s| s.eq_ignore_ascii_case("jsonc"))
            {
                "jsonc"
            } else {
                "json"
            }
            .into(),
        );
        if let Some((kind, mut value)) = index.root {
            if value.end == 0 {
                value.end = raw.document().len();
            }
            let container = matches!(kind, json::Kind::Object | json::Kind::Array).then_some(0);
            info.root = Some(node(
                raw,
                entry.generation,
                index,
                0,
                json::Child { key: None, value, kind, container, text: Vec::new() },
                false,
            )?);
        }
        if let Some(error) = index.error {
            let message = match error.kind {
                json::ErrorKind::Syntax(message) => message,
                json::ErrorKind::TooDeep => "Tree nesting limit reached",
                json::ErrorKind::TooManyContainers => "Tree container limit reached",
                _ => "Tree parsing stopped",
            };
            info.status =
                if info.root.as_ref().is_some_and(|n| n.children.unwrap_or(0.) > 0.) { "partial" } else { "locked" }
                    .into();
            info.reason = Some(message.into());
            info.problems.push(StructuredProblem {
                kind: "parse".into(),
                count: 1.,
                message: message.into(),
                first: Span { start: error.offset as f64, end: error.offset as f64 },
                line: Some(error.line as f64),
                column: Some(error.column as f64),
            });
        }
        if let Some(&(container, ordinal)) = tree.duplicates.first() {
            let first = raw
                .document()
                .verified(entry.generation, |store| json::children(store, index, container, ordinal, 1))?
                .first()
                .and_then(|c| c.key)
                .unwrap_or(json::Span { start: 0, end: 0 });
            info.problems.push(StructuredProblem {
                kind: "duplicate-key".into(),
                count: tree.duplicates.len() as f64,
                message: "Duplicate keys are preserved".into(),
                first: span(first),
                line: None,
                column: None,
            });
        }
    } else if entry.format == "json" || entry.format == "jsonl" && entry.jsonl.is_none() {
        info.status = "locked".into();
        info.done = true;
        info.reason = Some("Structured views are unavailable for UTF-16; Raw remains available".into());
    }
    if entry.format == "yaml" && raw.document().len() > 8 << 20 {
        info.status = "locked".into();
        info.reason = Some("YAML Tree is available up to 8 MiB".into());
    }
    if let Some(index) = &entry.jsonl {
        let progress = index.progress.read().unwrap().clone();
        info.rows = Some((progress.lines - progress.blank) as f64);
        info.parsed = Some(progress.parsed as f64);
        info.failed = Some(progress.failed as f64);
        info.blank = Some(progress.blank as f64);
        info.done = progress.done;
        info.status = if progress.done { "ready" } else { "indexing" }.into();
        info.columns = Some(index.column_count() as f64);
        info.table_off = progress.table_off;
        info.schema = Some(
            if progress.claude >= 3 {
                "claude-code-v1"
            } else if progress.openai_messages + progress.openai_dataset >= 3 {
                "openai-chat-v1"
            } else {
                "generic"
            }
            .into(),
        );
        if let Some((line, first)) = progress.first_failed {
            info.problems.push(StructuredProblem {
                kind: "parse".into(),
                count: progress.failed as f64,
                message: "Lines could not be parsed as JSON".into(),
                first: span(first),
                line: Some((line + 1) as f64),
                column: None,
            });
        }
        if let Some(error) = progress.error {
            info.status = "partial".into();
            info.reason = Some(error);
        }
    }
    Ok(info)
}
pub struct Build {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    generation: u32,
    revision: u32,
    epoch: u64,
    format: &'static str,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    existing: Option<Arc<Entry>>,
    index_temp: Option<Reservation>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Build {
    type Output = std::result::Result<(Arc<Entry>, StructuredInfo), DocError>;
    type JsValue = StructuredInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            if let Some(entry) = &self.existing {
                return Ok((entry.clone(), describe(&self.raw, entry)?));
            }
            self.slot = Some(budget::slot(Work::Index, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            let utf16 = self.raw.encoding().starts_with("UTF-16");
            let tree = if self.format == "json" && !utf16 {
                Some(core_structured::JsonTree::build(self.raw.document(), self.generation)?)
            } else {
                None
            };
            let jsonl = if self.format == "jsonl" && !utf16 {
                self.index_temp = Some(Reservation::new(core_structured::TEMP_BYTES).map_err(DocError::Memory)?);
                Some(Arc::new(jsonl::Index::with_encoding(self.raw.source_encoding())?))
            } else {
                None
            };
            let entry = Arc::new(Entry {
                generation: self.generation,
                revision: self.revision,
                format: self.format,
                tree,
                jsonl,
                cancel: Arc::new(AtomicBool::new(false)),
            });
            let info = describe(&self.raw, &entry)?;
            Ok((entry, info))
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output.and_then(|(entry, info)| {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            if self.owner.closed.load(Ordering::Relaxed) || self.owner.epoch.load(Ordering::Relaxed) != self.epoch {
                return Err(DocError::Stale { current: 0, asked: self.revision });
            }
            self.raw.document().verified(self.generation, |_| Ok(()))?;
            if self.existing.is_some() {
                if !self.owner.current(&entry) {
                    return Err(DocError::Stale { current: 0, asked: self.revision });
                }
                return Ok(info);
            }
            if let Some(index) = &entry.jsonl {
                let index = index.clone();
                let raw = self.raw.clone();
                let flag = entry.cancel.clone();
                let slot = self.slot.take().expect("JSONL candidate owns an index slot");
                let temp = self.index_temp.take().expect("JSONL candidate owns its temporary reservation");
                let generation = self.generation;
                #[cfg(feature = "test-hooks")]
                let job = hooks::Live::new(&hooks::JOBS);
                std::thread::Builder::new()
                    .name("typose-jsonl".into())
                    .spawn(move || {
                        let _slot = slot;
                        #[cfg(feature = "test-hooks")]
                        let _job = job;
                        let result = cancellable(&flag, || index.build_reserved(raw.document(), generation, temp));
                        if let Err(error) = result
                            && !matches!(error, DocError::Cancelled)
                        {
                            index.progress.write().unwrap().error = Some(error.to_string());
                        }
                    })
                    .map_err(DocError::Io)?;
            }
            self.owner.state.lock().unwrap().replace(entry);
            Ok(info)
        });
        result.map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
pub struct Children {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    entry: Arc<Entry>,
    container: u32,
    start: u64,
    count: usize,
    record: Option<u64>,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Children {
    type Output = std::result::Result<StructuredChildren, DocError>;
    type JsValue = StructuredChildren;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            // One identity check for the page, not one per node key and value.
            self.raw.document().batch(self.entry.generation, || {
                let record_tree;
                let tree = if let Some(record) = self.record {
                    if self.entry.format != "jsonl" {
                        return Err(DocError::Invalid("Record scope is only valid for JSONL".into()));
                    }
                    let range = record_range(&self.raw, self.entry.generation, record)?
                        .ok_or_else(|| DocError::Invalid("JSONL record is outside the document".into()))?;
                    let range = record_body(&self.raw, self.entry.generation, range)?;
                    record_tree = core_structured::JsonTree::build_range(
                        self.raw.document(),
                        self.entry.generation,
                        range.start..range.end,
                        false,
                    )?;
                    &record_tree
                } else {
                    self.entry
                        .tree
                        .as_ref()
                        .ok_or_else(|| DocError::Invalid("This structured document has no JSON Tree".into()))?
                };
                let children =
                    tree.children(self.raw.document(), self.entry.generation, self.container, self.start, self.count)?;
                let mut nodes = Vec::with_capacity(children.len());
                let mut bytes = 1024;
                for (ordinal, child, duplicate) in children {
                    let value = node(&self.raw, self.entry.generation, &tree.index, ordinal, child, duplicate)?;
                    let cost = 512
                        + 6 * (value.text.encode_utf16().count()
                            + value.key.as_ref().map_or(0, |k| k.encode_utf16().count()));
                    if bytes + cost > 256 << 10 {
                        break;
                    }
                    bytes += cost;
                    nodes.push(value);
                }
                let next = self.start + nodes.len() as u64;
                let total = tree.index.containers.get(self.container as usize).map_or(0, |c| c.children);
                Ok(StructuredChildren { nodes, next: (next < total).then_some(next as f64) })
            })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output.and_then(|page| {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            if !self.owner.current(&self.entry) {
                return Err(DocError::Stale { current: 0, asked: self.entry.revision });
            }
            self.raw.document().verified(self.entry.generation, |_| Ok(()))?;
            Ok(page)
        });
        result.map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<StructuredInfo>")]
    pub fn structured_build(
        &self,
        generation: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Build>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let raw = self.raw()?;
        if raw.document().generation() != generation {
            return Err(doc_error(DocError::Stale { current: raw.document().generation(), asked: generation }));
        }
        let format = format(raw.document().path())
            .ok_or_else(|| Error::new(Code::Refused, "No structured lens for this format"))?;
        let charge = Reservation::new(core_structured::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        let existing = self
            .structured
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|entry| entry.generation == generation && entry.format == format)
            .cloned();
        let revision = if let Some(entry) = &existing {
            entry.revision
        } else {
            self.structured
                .next
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
                .map_err(|_| Error::new(Code::Refused, "structured identities exhausted"))?
                + 1
        };
        let epoch = if existing.is_some() {
            self.structured.epoch.load(Ordering::Relaxed)
        } else {
            self.structured.epoch.fetch_add(1, Ordering::Relaxed) + 1
        };
        if existing.is_none()
            && let Some(flag) = self.structured.pending.lock().unwrap().replace(cancel.flag.clone())
        {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(AsyncTask::new(Build {
            raw: raw.clone(),
            owner: self.structured.clone(),
            generation,
            revision,
            epoch,
            format,
            cancel: cancel.flag.clone(),
            slot: None,
            existing,
            index_temp: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    #[napi(ts_return_type = "Promise<StructuredChildren>")]
    #[allow(clippy::too_many_arguments, reason = "napi page request carries exact owner, range, cancel and record")]
    pub fn structured_children(
        &self,
        generation: f64,
        revision: f64,
        container: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
        record: Option<f64>,
    ) -> std::result::Result<AsyncTask<Children>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let container = u32::try_from(int("start", container)?)
            .map_err(|_| Error::new(Code::InvalidParams, "container exceeds u32"))?;
        let start = int("start", start)?;
        let count = int("count", count)? as usize;
        if count > 128 {
            return Err(Error::new(Code::InvalidParams, "Tree count exceeds 128"));
        }
        let raw = self.raw()?;
        let entry = self
            .structured
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|e| e.generation == generation && e.revision == revision)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "structured index was replaced"))?;
        let charge = Reservation::new(core_structured::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(Children {
            raw: raw.clone(),
            owner: self.structured.clone(),
            entry,
            container,
            start,
            count,
            record: record.map(|line| int("line", line)).transpose()?,
            cancel: cancel.flag.clone(),
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
}

fn record_range(raw: &Raw, generation: u32, line: u64) -> std::result::Result<Option<json::Span>, DocError> {
    let start = if line == 0 {
        0
    } else {
        let Some(start) = raw.line_offset(generation, line)? else {
            return Ok(None);
        };
        start
    };
    if start >= raw.document().len() {
        return Ok(None);
    }
    let end = if let Some(end) = raw.line_offset(generation, line + 1)? {
        end
    } else if raw.lines_known().1 {
        raw.document().len()
    } else {
        return Err(DocError::Refused("The record end is not indexed yet".into()));
    };
    Ok(Some(json::Span { start, end }))
}
/// What the parser reads of a record: its range without the line terminator.
fn record_body(raw: &Raw, generation: u32, range: json::Span) -> std::result::Result<json::Span, DocError> {
    raw.document().verified(generation, |store| jsonl::content(store, range))
}

#[napi(object)]
pub struct StructuredRow {
    pub line: f64,
    pub span: Span,
    pub status: String,
    pub timestamp: Option<String>,
    pub r#type: Option<String>,
    pub summary: String,
    pub root: Option<StructuredNode>,
    pub problem: Option<String>,
    pub more: bool,
}
#[napi(object)]
pub struct StructuredRows {
    pub rows: Vec<StructuredRow>,
    pub next_line: Option<f64>,
    pub done: bool,
}
#[napi(object)]
pub struct StructuredColumn {
    pub id: f64,
    pub key: String,
    pub span: Span,
}
#[napi(object)]
pub struct StructuredColumns {
    pub columns: Vec<StructuredColumn>,
    pub next: Option<f64>,
    pub total: f64,
    pub done: bool,
}

fn row(
    raw: &Raw,
    generation: u32,
    line: u64,
    range: json::Span,
) -> std::result::Result<Option<StructuredRow>, DocError> {
    let body = record_body(raw, generation, range)?;
    let tree = core_structured::JsonTree::build_range(raw.document(), generation, body.start..body.end, false)?;
    if tree.index.root.is_none() && tree.index.error.is_none() {
        return Ok(None);
    }
    let bytes = raw.document().read(generation, range.start, range.end.min(range.start + 4096))?;
    let mut result = StructuredRow {
        line: line as f64,
        span: span(range),
        status: if tree.index.error.is_some() { "failed" } else { "valid" }.into(),
        timestamp: None,
        r#type: None,
        summary: raw.source_encoding().decode_without_bom_handling(&bytes).0.trim().into(),
        root: None,
        problem: None,
        // A failed row's summary is its first 4,096 bytes: `more` says that clipped it.
        more: body.end - body.start > 4096,
    };
    if let Some(error) = tree.index.error {
        result.problem = Some(
            match error.kind {
                json::ErrorKind::Syntax(message) => message,
                json::ErrorKind::TooDeep => "Nesting limit reached",
                _ => "Record parsing stopped",
            }
            .into(),
        );
    }
    if let Some((kind, value)) = tree.index.root {
        if value.end > 0 {
            let container = matches!(kind, json::Kind::Object | json::Kind::Array).then_some(0);
            result.root = Some(node(
                raw,
                generation,
                &tree.index,
                0,
                json::Child { key: None, value, kind, container, text: Vec::new() },
                false,
            )?);
        }
        if tree.index.error.is_none() {
            let mut shown = Vec::new();
            raw.document().verified(generation, |store| {
                if kind == json::Kind::Object {
                    jsonl::visit_members(store, &tree.index, 0, |child| {
                        let Some(key) = child.key.filter(|key| key.end - key.start <= 4096) else {
                            return Ok(true);
                        };
                        let key = jsonl::read_string_encoding(store, key, raw.source_encoding())?;
                        if result.timestamp.is_none()
                            && matches!(key.as_str(), "ts" | "time" | "timestamp" | "created_at")
                            && matches!(child.kind, json::Kind::String | json::Kind::Number)
                        {
                            result.timestamp = Some(scalar(raw, store, &child)?);
                            shown.push(key);
                        } else if result.r#type.is_none()
                            && matches!(key.as_str(), "type" | "role" | "level" | "event")
                            && child.kind == json::Kind::String
                        {
                            result.r#type = Some(scalar(raw, store, &child)?);
                            shown.push(key);
                        }
                        Ok(!(result.timestamp.is_some() && result.r#type.is_some()))
                    })?;
                }
                (result.summary, result.more) =
                    compose(raw, store, &tree.index, kind, value, body.end - body.start, &shown)?;
                Ok(())
            })?;
        }
    }
    Ok(Some(result))
}

const MESSAGE_KEYS: [&str; 5] = ["message", "msg", "text", "content", "summary"];
const NAME_KEYS: [&str; 3] = ["name", "tool", "tool_name"];
const ARGUMENT_KEYS: [&str; 6] = ["input", "arguments", "args", "params", "parameters", "tool_input"];
const PATH_KEYS: [&str; 10] =
    ["file_path", "path", "file", "filename", "filePath", "notebook_path", "uri", "url", "target", "cwd"];
type Reads<T> = std::result::Result<T, store::StoreError>;

fn scalar(raw: &Raw, store: &store::ByteStore, child: &json::Child) -> Reads<String> {
    jsonl::read_string_encoding(store, child.value, raw.source_encoding())
}
/// Whether a string's preview was cut short: the read takes 4,096 bytes from the opening quote, so 4,095 of content.
fn cut(value: json::Span) -> bool {
    (value.end - value.start).saturating_sub(2) > 4095
}
fn clip(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() { head + "…" } else { head }
}
fn size(bytes: u64) -> String {
    match bytes {
        0..1024 => format!("{bytes} B"),
        1024..1_048_576 => format!("{:.1} KB", bytes as f64 / 1024.0),
        _ => format!("{:.1} MB", bytes as f64 / 1_048_576.0),
    }
}
enum Gist {
    Said(String, bool),
    Tool(String),
}
/// Z80: a readable line, never the record's JSON. The first message-like string, looked for in a nested message and
/// its first content blocks too; else a tool call's name, path-like argument and the record's size; else the first
/// scalar pairs. Bounded: five object levels (arrays between them don't count), four blocks per array.
fn compose(
    raw: &Raw,
    store: &store::ByteStore,
    index: &json::JsonIndex,
    kind: json::Kind,
    value: json::Span,
    bytes: u64,
    shown: &[String],
) -> Reads<(String, bool)> {
    match kind {
        json::Kind::Object | json::Kind::Array => {}
        _ => {
            let root = json::Child { key: None, value, kind, container: None, text: Vec::new() };
            return Ok((clip(&scalar(raw, store, &root)?, 4096), false));
        }
    }
    match gist(raw, store, index, 0, 0)? {
        Some(Gist::Said(text, more)) => return Ok((text, more)),
        Some(Gist::Tool(call)) => return Ok((format!("{call} · {}", size(bytes)), false)),
        None => {}
    }
    if kind == json::Kind::Array {
        let items = index.containers.get(0).map_or(0, |c| c.children);
        return Ok((format!("[ {items} items ]"), false));
    }
    let mut pairs = Vec::new();
    jsonl::visit_members(store, index, 0, |child| {
        let Some(key) = child.key.filter(|key| key.end - key.start <= 4096) else {
            return Ok(true);
        };
        let key = jsonl::read_string_encoding(store, key, raw.source_encoding())?;
        if !shown.contains(&key) {
            let text = match child.kind {
                json::Kind::Object => "{…}".into(),
                json::Kind::Array => "[…]".into(),
                _ => clip(&scalar(raw, store, &child)?, 80),
            };
            pairs.push(format!("{}: {text}", clip(&key, 40)));
        }
        Ok(pairs.len() < 3)
    })?;
    Ok((pairs.join(" · "), false))
}
fn gist(
    raw: &Raw,
    store: &store::ByteStore,
    index: &json::JsonIndex,
    container: u32,
    depth: u32,
) -> Reads<Option<Gist>> {
    if depth > 4 {
        return Ok(None);
    }
    if index.containers.get(container as usize).is_some_and(|c| c.kind == json::Kind::Array) {
        let (mut found, mut seen) = (None, 0);
        jsonl::visit_members(store, index, container, |child| {
            seen += 1;
            found = match (child.kind, child.container) {
                (json::Kind::String, _) => Some(Gist::Said(scalar(raw, store, &child)?, cut(child.value))),
                (json::Kind::Object, Some(block)) => gist(raw, store, index, block, depth + 1)?,
                _ => None,
            };
            Ok(found.is_none() && seen < 4)
        })?;
        return Ok(found);
    }
    let names: Vec<&str> =
        MESSAGE_KEYS.iter().chain(&NAME_KEYS).chain(&ARGUMENT_KEYS).chain(["type"].iter()).copied().collect();
    let fields = jsonl::named_fields(store, index, container, &names)?;
    for key in MESSAGE_KEYS {
        if let Some(child) = fields.get(key).filter(|c| c.kind == json::Kind::String) {
            return Ok(Some(Gist::Said(scalar(raw, store, child)?, cut(child.value))));
        }
    }
    let kind =
        fields.get("type").filter(|c| c.kind == json::Kind::String).map(|c| scalar(raw, store, c)).transpose()?;
    let arguments = ARGUMENT_KEYS.iter().find_map(|key| fields.get(*key));
    let tool_like = arguments.is_some() || kind.is_some_and(|kind| kind.contains("tool") || kind.contains("function"));
    if let Some(name) = NAME_KEYS.iter().find_map(|key| fields.get(*key)).filter(|c| c.kind == json::Kind::String)
        && tool_like
    {
        let mut call = clip(&scalar(raw, store, name)?, 80);
        // JSON-encoded arguments (OpenAI's `arguments` string) are searched for a path key, never shown.
        let mut path = match arguments.filter(|c| c.kind == json::Kind::String) {
            Some(encoded) => embedded_path(&scalar(raw, store, encoded)?),
            None => None,
        };
        for place in arguments.and_then(|c| c.container).into_iter().chain([container]) {
            if path.is_some() {
                break;
            }
            path = path_argument(raw, store, index, place)?;
        }
        if let Some(path) = path {
            call =
                format!("{call} {}", clip(path.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or(&path), 80));
        }
        return Ok(Some(Gist::Tool(call)));
    }
    for key in MESSAGE_KEYS {
        // Only object levels count toward the bound: an array of blocks is a list, not a level.
        if let Some(inner) = fields.get(key).and_then(|c| c.container)
            && let Some(found) =
                gist(raw, store, index, inner, depth + u32::from(fields[key].kind == json::Kind::Object))?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}
/// Never JSON: a path candidate that opens like an object or array, or holds a quote, is encoded data.
fn plausible(text: &str) -> bool {
    !text.is_empty() && !text.starts_with(['{', '[']) && !text.contains('"')
}
/// A known path key's string inside JSON-encoded arguments, found textually (`"key"`, `:`, then a string), so no
/// second parser runs on the record; `\\` and `\/` are the only escapes a basename needs undone.
fn embedded_path(text: &str) -> Option<String> {
    PATH_KEYS.iter().find_map(|key| {
        let at = text.find(&format!("\"{key}\""))? + key.len() + 2;
        let value = text[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
        let mut escaped = false;
        let (end, _) = value.char_indices().find(|&(_, c)| {
            let quote = c == '"' && !escaped;
            escaped = c == '\\' && !escaped;
            quote
        })?;
        Some(value[..end].replace("\\\\", "\\").replace("\\/", "/")).filter(|path| plausible(path))
    })
}
/// A known path key's string, else the first string that looks like a path: no whitespace, with a separator.
fn path_argument(
    raw: &Raw,
    store: &store::ByteStore,
    index: &json::JsonIndex,
    container: u32,
) -> Reads<Option<String>> {
    if index.containers.get(container as usize).is_none_or(|c| c.kind != json::Kind::Object) {
        return Ok(None);
    }
    let (mut named, mut looks, mut seen) = (None, None, 0);
    jsonl::visit_members(store, index, container, |child| {
        seen += 1;
        if child.kind == json::Kind::String
            && let Some(key) = child.key.filter(|key| key.end - key.start <= 4096)
        {
            let key = jsonl::read_string_encoding(store, key, raw.source_encoding())?;
            let text = scalar(raw, store, &child)?;
            if !plausible(&text) {
                return Ok(seen < 32);
            }
            if PATH_KEYS.contains(&key.as_str()) {
                named = Some(text);
            } else if looks.is_none() && text.contains(['/', '\\']) && !text.contains(char::is_whitespace) {
                looks = Some(text);
            }
        }
        Ok(named.is_none() && seen < 32)
    })?;
    Ok(named.or(looks))
}
fn check_read(raw: &Raw, owner: &Owner, entry: &Arc<Entry>, flag: &AtomicBool) -> std::result::Result<(), DocError> {
    if flag.load(Ordering::Relaxed) {
        return Err(DocError::Cancelled);
    }
    if !owner.current(entry) {
        return Err(DocError::Stale { current: 0, asked: entry.revision });
    }
    raw.document().verified(entry.generation, |_| Ok(()))
}
pub struct Rows {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    entry: Arc<Entry>,
    start: u64,
    count: usize,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Rows {
    type Output = std::result::Result<StructuredRows, DocError>;
    type JsValue = StructuredRows;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            check_read(&self.raw, &self.owner, &self.entry, &flag)?;
            if self.entry.format != "jsonl" || self.entry.jsonl.is_none() {
                return Err(DocError::Refused("Rows are unavailable for this document".into()));
            }
            // One identity check for the page, not several per record.
            self.raw.document().batch(self.entry.generation, || {
                let (mut at, mut scanned, mut source_bytes, mut wire) = (self.start, 0, 0, 1024);
                let mut rows = Vec::with_capacity(self.count);
                let mut done = false;
                while rows.len() < self.count && scanned < 512 && source_bytes < 4 << 20 {
                    if store::cancelled() {
                        return Err(DocError::Cancelled);
                    }
                    let range = match record_range(&self.raw, self.entry.generation, at) {
                        Ok(Some(range)) => range,
                        Ok(None) => {
                            done = self.raw.lines_known().1;
                            break;
                        }
                        Err(DocError::Refused(_)) => break,
                        Err(error) => return Err(error),
                    };
                    source_bytes += range.end - range.start;
                    scanned += 1;
                    if let Some(value) = row(&self.raw, self.entry.generation, at, range)? {
                        let cost = 1024
                            + 6 * (value.summary.encode_utf16().count()
                                + value.root.as_ref().map_or(0, |n| n.text.encode_utf16().count())
                                + value.timestamp.as_ref().map_or(0, |s| s.encode_utf16().count())
                                + value.r#type.as_ref().map_or(0, |s| s.encode_utf16().count()));
                        if wire + cost > 256 << 10 {
                            break;
                        }
                        wire += cost;
                        rows.push(value);
                    }
                    at += 1;
                    if range.end == self.raw.document().len() {
                        done = true;
                        break;
                    }
                }
                Ok(StructuredRows { rows, next_line: (!done).then_some(at as f64), done })
            })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .and_then(|page| {
                check_read(&self.raw, &self.owner, &self.entry, &self.cancel)?;
                Ok(page)
            })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
pub struct Columns {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    entry: Arc<Entry>,
    start: usize,
    count: usize,
    cancel: Arc<AtomicBool>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Columns {
    type Output = std::result::Result<StructuredColumns, DocError>;
    type JsValue = StructuredColumns;
    fn compute(&mut self) -> Result<Self::Output> {
        let result = (|| {
            check_read(&self.raw, &self.owner, &self.entry, &self.cancel)?;
            let index =
                self.entry.jsonl.as_ref().ok_or_else(|| DocError::Refused("No JSONL columns are available".into()))?;
            let mut columns = Vec::with_capacity(self.count);
            let mut wire = 1024;
            for (offset, column) in index.columns(self.start, self.count).into_iter().enumerate() {
                let cost = 512 + 6 * column.key.encode_utf16().count();
                if wire + cost > 256 << 10 {
                    break;
                }
                wire += cost;
                columns.push(StructuredColumn {
                    id: (self.start + offset) as f64,
                    key: column.key,
                    span: span(column.span),
                });
            }
            let total = index.column_count();
            let next = self.start + columns.len();
            let done = index.progress.read().unwrap().done;
            Ok(StructuredColumns { columns, next: (next < total).then_some(next as f64), total: total as f64, done })
        })();
        Ok(result)
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .and_then(|page| {
                check_read(&self.raw, &self.owner, &self.entry, &self.cancel)?;
                Ok(page)
            })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
#[napi]
impl Doc {
    fn structured_entry(
        &self,
        generation: f64,
        revision: f64,
    ) -> std::result::Result<(Arc<Raw>, Arc<Entry>), Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let raw = self.raw()?.clone();
        let entry = self
            .structured
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|e| e.generation == generation && e.revision == revision)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "Structured index was replaced"))?;
        Ok((raw, entry))
    }
    #[napi(ts_return_type = "Promise<StructuredRows>")]
    pub fn structured_rows(
        &self,
        generation: f64,
        revision: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Rows>, Error<Code>> {
        let (raw, entry) = self.structured_entry(generation, revision)?;
        let start = int("line", start)?;
        let count = int("count", count)? as usize;
        if count > 128 {
            return Err(Error::new(Code::InvalidParams, "Rows count exceeds 128"));
        }
        let charge = Reservation::new(core_structured::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(Rows {
            raw,
            owner: self.structured.clone(),
            entry,
            start,
            count,
            cancel: cancel.flag.clone(),
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    #[napi(ts_return_type = "Promise<StructuredColumns>")]
    pub fn structured_columns(
        &self,
        generation: f64,
        revision: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Columns>, Error<Code>> {
        let (raw, entry) = self.structured_entry(generation, revision)?;
        let start = usize::try_from(int("start", start)?)
            .map_err(|_| Error::new(Code::InvalidParams, "Column start exceeds platform range"))?;
        let count = int("count", count)? as usize;
        if count > 128 {
            return Err(Error::new(Code::InvalidParams, "Column count exceeds 128"));
        }
        let charge = Reservation::new(core_structured::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(Columns {
            raw,
            owner: self.structured.clone(),
            entry,
            start,
            count,
            cancel: cancel.flag.clone(),
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
}
