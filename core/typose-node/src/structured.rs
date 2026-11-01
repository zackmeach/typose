//! Generation-owned span indexes and bounded structured pages.
use super::*;
use std::sync::atomic::{AtomicU32, AtomicU64};
use typose_core::{json, structured as core_structured};

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
        if let Some(flag) = self.pending.lock().unwrap().take() { flag.store(true, Ordering::Relaxed); }
        self.state.lock().unwrap().take();
    }
    #[cfg(feature = "test-hooks")]
    pub(super) fn charged(&self) -> u64 {
        self.state.lock().unwrap().as_ref().and_then(|e| e.tree.as_ref()).map_or(0, |t| t.charged())
    }
    fn current(&self, entry: &Arc<Entry>) -> bool {
        !self.closed.load(Ordering::Relaxed)
            && self.state.lock().unwrap().as_ref().is_some_and(|e| Arc::ptr_eq(e, entry))
    }
}
#[napi(object)]
pub struct StructuredSpan {
    pub start: f64,
    pub end: f64,
}
#[napi(object)]
pub struct StructuredNode {
    pub ordinal: f64,
    pub kind: String,
    pub span: StructuredSpan,
    pub key: Option<String>,
    pub key_span: Option<StructuredSpan>,
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
    pub first: StructuredSpan,
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
}
#[napi(object)]
pub struct StructuredChildren {
    pub nodes: Vec<StructuredNode>,
    pub next: Option<f64>,
}
fn span(s: json::Span) -> StructuredSpan {
    StructuredSpan { start: s.start as f64, end: s.end as f64 }
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
        .map(|s| {
            raw.document()
                .read(generation, s.start, s.end.min(s.start + 1024))
                .map(|bytes| raw.source_encoding().decode_without_bom_handling(&bytes).0.into_owned())
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
                first: StructuredSpan { start: error.offset as f64, end: error.offset as f64 },
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
    } else if entry.format == "json" {
        info.status = "locked".into();
        info.reason = Some("Tree is unavailable for UTF-16; Raw remains available".into());
    }
    if entry.format == "yaml" && raw.document().len() > 8 << 20 {
        info.status = "locked".into();
        info.reason = Some("YAML Tree is available up to 8 MiB".into());
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
            self.slot = Some(budget::slot(Work::Index, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            let utf16 = self.raw.encoding().starts_with("UTF-16");
            let tree = if self.format == "json" && !utf16 {
                Some(core_structured::JsonTree::build(self.raw.document(), self.generation, &flag)?)
            } else {
                None
            };
            let entry =
                Arc::new(Entry { generation: self.generation, revision: self.revision, format: self.format, tree });
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
            let tree = self
                .entry
                .tree
                .as_ref()
                .ok_or_else(|| DocError::Invalid("This structured document has no JSON Tree".into()))?;
            let children = tree.children(
                self.raw.document(),
                self.entry.generation,
                self.container,
                self.start,
                self.count,
                &flag,
            )?;
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
        let revision = self
            .structured
            .next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::new(Code::Refused, "structured identities exhausted"))?
            + 1;
        let epoch = self.structured.epoch.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(flag) = self.structured.pending.lock().unwrap().replace(cancel.flag.clone()) { flag.store(true, Ordering::Relaxed); }
        Ok(AsyncTask::new(Build {
            raw: raw.clone(),
            owner: self.structured.clone(),
            generation,
            revision,
            epoch,
            format,
            cancel: cancel.flag.clone(),
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    #[napi(ts_return_type = "Promise<StructuredChildren>")]
    pub fn structured_children(
        &self,
        generation: f64,
        revision: f64,
        container: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
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
            cancel: cancel.flag.clone(),
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
}
