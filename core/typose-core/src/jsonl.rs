//! Streaming JSONL metadata. Record payloads remain file-backed and are parsed only while in use.
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

use crate::budget::Reservation;
use crate::doc::{DocError, Document};
use crate::json::{self, Child, JsonIndex, Kind, Span};
use crate::store::{ByteStore, StoreError, cancelled};

#[derive(Default, Clone)]
pub struct Progress {
    pub lines: u64,
    pub parsed: u64,
    pub failed: u64,
    pub blank: u64,
    pub bytes: u64,
    pub done: bool,
    pub first_failed: Option<(u64, Span)>,
    pub sample_parsed: u64,
    pub claude: u64,
    pub openai_messages: u64,
    pub openai_dataset: u64,
    pub error: Option<String>,
    pub table_off: Option<String>,
}

#[derive(Clone)]
pub struct Column {
    pub key: String,
    pub span: Span,
}
#[derive(Default)]
struct Columns {
    values: Vec<Column>,
    by_key: HashMap<String, usize>,
}
pub struct Index {
    pub progress: RwLock<Progress>,
    columns: Mutex<Columns>,
    charge: Mutex<Reservation>,
    encoding: &'static encoding_rs::Encoding,
    pub transcript: Mutex<crate::transcript::Graph>,
}
impl Index {
    pub fn with_encoding(encoding: &'static encoding_rs::Encoding) -> Result<Self, DocError> {
        Ok(Self {
            progress: RwLock::new(Progress::default()),
            columns: Mutex::new(Columns::default()),
            charge: Mutex::new(Reservation::new(16 << 10).map_err(DocError::Memory)?),
            encoding,
            transcript: Mutex::new(crate::transcript::Graph::new()),
        })
    }
    pub fn charged(&self) -> u64 {
        self.charge.lock().unwrap().bytes() + self.transcript.lock().unwrap().charged()
    }
    pub fn column_count(&self) -> usize {
        self.columns.lock().unwrap().values.len()
    }
    pub fn columns(&self, start: usize, count: usize) -> Vec<Column> {
        self.columns.lock().unwrap().values.iter().skip(start).take(count).cloned().collect()
    }
    fn add_column(&self, store: &ByteStore, span: Span) -> Result<(), StoreError> {
        if self.progress.read().unwrap().table_off.is_some() {
            return Ok(());
        }
        if span.end - span.start > 4096 {
            self.progress.write().unwrap().table_off =
                Some("A key exceeds the Table metadata limit; Rows keeps the full record".into());
            return Ok(());
        }
        let key = read_string_encoding(store, span, self.encoding)?;
        let mut columns = self.columns.lock().unwrap();
        if columns.by_key.contains_key(&key) {
            return Ok(());
        }
        // Two owned key strings plus amortized Vec/HashMap capacity and allocation overlap.
        if self.charge.lock().unwrap().grow(512 + 4 * key.len() as u64).is_err() {
            self.progress.write().unwrap().table_off =
                Some("The memory budget cannot hold more Table columns; Rows remains available".into());
            return Ok(());
        }
        let id = columns.values.len();
        columns.by_key.insert(key.clone(), id);
        columns.values.push(Column { key, span });
        Ok(())
    }
    pub fn build_reserved(&self, doc: &Document, generation: u32, _temp: Reservation) -> Result<(), DocError> {
        let complete = doc.verified(generation, |store| {
            let (mut at, mut from, mut line) = (0, 0, 0);
            while at < store.len() {
                if cancelled() || doc.frozen().is_some() {
                    return Err(StoreError::Cancelled);
                }
                let bytes = store.read(at, (at + 65_536).min(store.len()))?;
                for end in memchr::memchr_iter(b'\n', &bytes).map(|i| at + i as u64 + 1) {
                    if !self.record(store, Span { start: from, end }, line)? {
                        return Ok(false);
                    }
                    from = end;
                    line += 1;
                }
                at += bytes.len() as u64;
                self.progress.write().unwrap().bytes = at;
            }
            if from < store.len() && !self.record(store, Span { start: from, end: store.len() }, line)? {
                return Ok(false);
            }
            Ok(true)
        });
        if let Ok(true) = complete {
            let schema = detected_schema(&self.progress.read().unwrap());
            self.transcript.lock().unwrap().finish(schema)?;
        } else {
            self.transcript.lock().unwrap().stop();
        }
        self.progress.write().unwrap().done = complete?;
        Ok(())
    }
    fn record(&self, store: &ByteStore, span: Span, line: u64) -> Result<bool, StoreError> {
        let body = content(store, span)?;
        let index = json::scan(store, body.start..body.end, false)?;
        if let Some(error) = index.error {
            match error.kind {
                json::ErrorKind::Cancelled => return Err(StoreError::Cancelled),
                json::ErrorKind::Memory(_) => {
                    self.progress.write().unwrap().error = Some("The memory budget stopped JSONL indexing".into());
                    return Ok(false);
                }
                _ => {}
            }
        }
        {
            let mut progress = self.progress.write().unwrap();
            progress.lines = line + 1;
            if index.error.is_some() {
                progress.failed += 1;
                progress.first_failed.get_or_insert((line, span));
                return Ok(true);
            }
            if index.root.is_none() {
                progress.blank += 1;
                return Ok(true);
            }
            progress.parsed += 1;
        }
        if index.root.is_some_and(|(kind, _)| kind == Kind::Object) {
            visit_members(store, &index, 0, |child| {
                if let Some(key) = child.key {
                    self.add_column(store, key)?;
                }
                Ok(true)
            })?;
        }
        if self.progress.read().unwrap().sample_parsed < 200 {
            let fields = named_fields(
                store,
                &index,
                0,
                &["type", "message", "uuid", "parentUuid", "messages", "role", "content"],
            )?;
            let value = |name: &str| {
                fields.get(name).filter(|c| c.kind == Kind::String).map(|c| read_string(store, c.value)).transpose()
            };
            let mut claude = false;
            if matches!(value("type")?.as_deref(), Some("user" | "assistant"))
                && fields.contains_key("uuid")
                && fields.contains_key("parentUuid")
                && let Some(container) =
                    fields.get("message").filter(|c| c.kind == Kind::Object).and_then(|c| c.container)
            {
                let message = named_fields(store, &index, container, &["role", "content"])?;
                claude = message.contains_key("role") && message.contains_key("content");
            }
            let openai_message = value("role")?.is_some_and(|role| known_role(&role)) && fields.contains_key("content");
            let mut dataset = false;
            if let Some(container) = fields.get("messages").filter(|c| c.kind == Kind::Array).and_then(|c| c.container)
            {
                let mut count = 0;
                let mut valid = true;
                visit_members(store, &index, container, |message| {
                    count += 1;
                    let Some(container) = message.container.filter(|_| message.kind == Kind::Object) else {
                        valid = false;
                        return Ok(false);
                    };
                    let fields = named_fields(store, &index, container, &["role", "content"])?;
                    valid = fields
                        .get("role")
                        .filter(|c| c.kind == Kind::String)
                        .map(|c| read_string(store, c.value))
                        .transpose()?
                        .is_some_and(|role| known_role(&role))
                        && fields.contains_key("content");
                    Ok(valid)
                })?;
                dataset = count > 0 && valid;
            }
            let mut progress = self.progress.write().unwrap();
            progress.sample_parsed += 1;
            progress.claude += u64::from(claude);
            // A dataset line with a role and content of its own is a dataset line, once.
            progress.openai_messages += u64::from(openai_message && !dataset);
            progress.openai_dataset += u64::from(dataset);
        }
        let progress = self.progress.read().unwrap();
        let undetected = progress.sample_parsed >= 200 && detected_schema(&progress).is_none();
        drop(progress);
        let mut graph = self.transcript.lock().unwrap();
        if undetected {
            graph.reject_undetected();
        } else {
            graph.observe(store, &index, line, span)?;
        }
        Ok(true)
    }
}

/// Brief §5.4's detection: 3 of the first 200 parsed records match a schema. Dataset lines and message lines are both
/// OpenAI chat; the more numerous names the mode.
pub fn detected_schema(progress: &Progress) -> Option<&'static str> {
    if progress.claude >= 3 {
        Some("claude-code-v1")
    } else if progress.openai_dataset + progress.openai_messages >= 3 {
        Some(if progress.openai_dataset >= progress.openai_messages { "openai-dataset-v1" } else { "openai-chat-v1" })
    } else {
        None
    }
}

/// A record without its line terminator, so a line cut off mid-string ends the input instead of holding a raw `\n`.
pub fn content(store: &ByteStore, span: Span) -> Result<Span, StoreError> {
    let tail = store.read(span.end.saturating_sub(2).max(span.start), span.end)?;
    let cut = match tail.as_slice() {
        [.., b'\r', b'\n'] => 2,
        [.., b'\n'] => 1,
        _ => 0,
    };
    Ok(Span { start: span.start, end: span.end - cut })
}

pub fn known_role(role: &str) -> bool {
    matches!(role, "system" | "developer" | "user" | "assistant" | "tool" | "function")
}

pub fn visit_members(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    mut visit: impl FnMut(Child) -> Result<bool, StoreError>,
) -> Result<(), StoreError> {
    let total = index.containers.get(container as usize).map_or(0, |c| c.children);
    let mut at = 0;
    while at < total {
        let page = json::children(store, index, container, at, 128)?;
        if page.is_empty() {
            break;
        }
        for child in page {
            at += 1;
            if !visit(child)? {
                return Ok(());
            }
        }
    }
    Ok(())
}
pub fn read_string(store: &ByteStore, span: Span) -> Result<String, StoreError> {
    read_string_encoding(store, span, encoding_rs::UTF_8)
}
pub fn read_string_encoding(
    store: &ByteStore,
    span: Span,
    encoding: &'static encoding_rs::Encoding,
) -> Result<String, StoreError> {
    let bytes = store.read(span.start, span.end.min(span.start + 4096))?;
    let decoded = encoding.decode_without_bom_handling(&bytes).0;
    Ok(String::from_utf8_lossy(&json::unescape(decoded.as_bytes())).into_owned())
}
pub fn named_fields(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    names: &[&str],
) -> Result<HashMap<String, Child>, StoreError> {
    let mut result = HashMap::with_capacity(names.len());
    if index.containers.get(container as usize).is_none_or(|c| c.kind != Kind::Object) {
        return Ok(result);
    }
    visit_members(store, index, container, |child| {
        if let Some(key) = child.key.filter(|s| s.end - s.start <= 4096) {
            let key = read_string(store, key)?;
            if names.contains(&key.as_str()) {
                result.entry(key).or_insert(child);
            }
        }
        Ok(result.len() < names.len())
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    #[test]
    fn metadata_preserves_failed_and_blank_lines_and_grows_columns() {
        let file = temp_file("jsonl-metadata", b"{\"a\":1}\n\nnope\n{\"b\":2}\n");
        let doc = Document::open(&file).unwrap();
        let index = Index::with_encoding(encoding_rs::UTF_8).unwrap();
        index.build_reserved(&doc, 1, Reservation::none()).unwrap();
        let p = index.progress.read().unwrap();
        assert_eq!((p.lines, p.parsed, p.failed, p.blank, p.done), (4, 2, 1, 1, true));
        assert_eq!(index.columns(0, 128).iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
    #[test]
    fn a_line_cut_off_mid_string_reports_the_end_of_input_not_its_terminator() {
        let source = b"{\"ts\":\"12:04:13.722\",\"msg\":\"Proposed moving the partn\r\n{\"b\":2}\n\n";
        let file = temp_file("jsonl-truncated", source);
        let doc = Document::open(&file).unwrap();
        let first = Span { start: 0, end: source.iter().position(|&b| b == b'\n').unwrap() as u64 + 1 };
        let error = doc
            .verified(1, |store| {
                let body = content(store, first)?;
                assert_eq!(body.end, first.end - 2);
                json::scan(store, body.start..body.end, true)
            })
            .unwrap()
            .error
            .unwrap();
        assert_eq!(error.kind, json::ErrorKind::Syntax("unexpected end of input"));
        let index = Index::with_encoding(encoding_rs::UTF_8).unwrap();
        index.build_reserved(&doc, 1, Reservation::none()).unwrap();
        let p = index.progress.read().unwrap();
        assert_eq!((p.lines, p.parsed, p.failed, p.blank), (3, 1, 1, 1));
    }
    #[test]
    fn detects_openai_message_and_dataset_records_without_loading_a_js_ast() {
        let file = temp_file("jsonl-adapter-detection", b"{\"role\":\"user\",\"content\":\"hi\"}\n{\"messages\":[{\"role\":\"assistant\",\"content\":\"hello\"}],\"metadata\":{}}\n");
        let doc = Document::open(&file).unwrap();
        let index = Index::with_encoding(encoding_rs::UTF_8).unwrap();
        index.build_reserved(&doc, 1, Reservation::none()).unwrap();
        let p = index.progress.read().unwrap();
        assert_eq!((p.sample_parsed, p.openai_messages, p.openai_dataset), (2, 1, 1));
    }
    #[test]
    fn the_reads_cancel_flag_stops_an_index_build() {
        let file = temp_file("jsonl-cancelled", b"{\"a\":1}\n{\"b\":2}\n");
        let doc = Document::open(&file).unwrap();
        let index = Index::with_encoding(encoding_rs::UTF_8).unwrap();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let cancelled = crate::store::cancellable(&cancel, || index.build_reserved(&doc, 1, Reservation::none()));
        assert!(matches!(cancelled, Err(DocError::Cancelled)), "{cancelled:?}");
        assert!(!index.progress.read().unwrap().done);
    }
}
