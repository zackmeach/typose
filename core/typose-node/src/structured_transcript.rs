//! Transcript pages (brief §5.4) over the JSONL index's graph (`typose_core::transcript`): bounded pages of items, of a
//! turn's tools, and of a text block's Markdown. Values are read from the verified source as they're paged.
use super::*;
use typose_core::transcript as model;

#[napi(object)]
pub struct TranscriptInfo {
    pub adapter: String,
    pub mode: String,
    pub confidence: f64,
    pub ready: bool,
    pub reason: Option<String>,
    pub messages: f64,
    pub events: f64,
    pub branches: f64,
    pub sidechains: f64,
    pub calls: f64,
    pub matched_results: f64,
    pub unmatched_results: f64,
}
pub(super) fn describe(index: &jsonl::Index) -> Option<TranscriptInfo> {
    let progress = index.progress.read().unwrap();
    let schema = jsonl::detected_schema(&progress)?;
    let matches =
        if schema == "claude-code-v1" { progress.claude } else { progress.openai_messages + progress.openai_dataset };
    let confidence = matches as f64 / progress.sample_parsed.max(1) as f64;
    drop(progress);
    let graph = index.transcript.lock().unwrap();
    Some(TranscriptInfo {
        adapter: if schema == "claude-code-v1" { "claude-code-v1" } else { "openai-chat-v1" }.into(),
        mode: if schema == "openai-dataset-v1" { "dataset" } else { "messages" }.into(),
        confidence,
        ready: graph.ready,
        reason: graph.reason.clone(),
        messages: graph.census.messages as f64,
        events: graph.census.events as f64,
        branches: graph.census.branches as f64,
        sidechains: graph.census.sidechains as f64,
        calls: graph.census.calls as f64,
        matched_results: graph.census.matched_results as f64,
        unmatched_results: graph.census.unmatched_results as f64,
    })
}
#[napi(object)]
pub struct TranscriptItem {
    pub id: f64,
    pub kind: String,
    pub record: f64,
    pub span: Span,
    pub root: StructuredNode,
    pub role: Option<String>,
    pub timestamp: Option<String>,
    pub content: Option<StructuredNode>,
    pub message_container: Option<u32>,
    pub children: f64,
    pub tools: f64,
    pub linked_results: Vec<Span>,
}
#[napi(object)]
pub struct TranscriptPage {
    pub items: Vec<TranscriptItem>,
    pub total: f64,
    pub next: Option<f64>,
    pub events: f64,
}
#[napi(object)]
pub struct TranscriptTool {
    pub ordinal: f64,
    pub name: String,
    pub id: String,
    pub block: StructuredNode,
    pub input: Option<StructuredNode>,
    pub results: f64,
}
#[napi(object)]
pub struct TranscriptResult {
    pub record: f64,
    pub span: Span,
    pub block: StructuredNode,
    pub content: Option<StructuredNode>,
}
#[napi(object)]
pub struct TranscriptTools {
    pub tools: Vec<TranscriptTool>,
    pub results: Vec<TranscriptResult>,
    pub total: f64,
    pub next: Option<f64>,
}
#[napi(object)]
pub struct TranscriptText {
    pub html: Vec<String>,
    pub next: Option<f64>,
    pub total: f64,
}
/// A node for a source value the graph points at: a scalar's first 4,096 bytes, or a container's id and child count.
fn value(raw: &Raw, generation: u32, reference: &model::SourceRef) -> std::result::Result<StructuredNode, DocError> {
    let container = reference.container;
    let length = reference.span.end - reference.span.start;
    let bytes = if container.is_some() {
        Vec::new()
    } else {
        raw.document().read(generation, reference.span.start, reference.span.end.min(reference.span.start + 4096))?
    };
    let (decoded, used) = typose_core::encoding::decode_prefix(
        &bytes,
        raw.source_encoding(),
        reference.span.start,
        bytes.len(),
        bytes.len() as u64 == length,
    );
    Ok(StructuredNode {
        ordinal: 0.,
        kind: match reference.kind {
            json::Kind::Object => "object",
            json::Kind::Array => "array",
            json::Kind::String => "string",
            json::Kind::Number => "number",
            json::Kind::True | json::Kind::False => "boolean",
            json::Kind::Null => "null",
        }
        .into(),
        span: span(reference.span),
        key: None,
        key_span: None,
        key_more: false,
        text: decoded.text,
        more: container.is_none() && (used as u64) < length,
        container,
        children: container.map(|_| reference.children as f64),
        duplicate: false,
    })
}
pub struct Context {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    entry: Arc<Entry>,
    cancel: Arc<AtomicBool>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Context {
    fn check(&self) -> std::result::Result<(), DocError> {
        check_read(&self.raw, &self.owner, &self.entry, &self.cancel)
    }
    fn index(&self) -> std::result::Result<&jsonl::Index, DocError> {
        self.entry.jsonl.as_deref().ok_or_else(|| DocError::Invalid("Transcript requires JSONL".into()))
    }
}
pub trait Query: Send + 'static {
    type Output: Send + ToNapiValue + TypeName;
    fn run(&self, context: &Context) -> std::result::Result<Self::Output, DocError>;
}
pub struct Read<Q: Query> {
    context: Context,
    query: Q,
}
impl<Q: Query> Task for Read<Q> {
    type Output = std::result::Result<Q::Output, DocError>;
    type JsValue = Q::Output;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.context.cancel.clone();
        Ok(cancellable(&flag, || {
            self.context.check()?;
            self.query.run(&self.context)
        }))
    }
    fn resolve(&mut self, env: Env, result: Self::Output) -> Result<Self::JsValue> {
        result
            .and_then(|value| {
                self.context.check()?;
                Ok(value)
            })
            .map_err(|e| err(env, e))
    }
}
pub struct Page {
    start: usize,
    count: usize,
    group: Option<usize>,
    events: bool,
}
impl Query for Page {
    type Output = TranscriptPage;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let graph = c.index()?.transcript.lock().unwrap();
        if !graph.ready {
            return Err(DocError::Refused(
                graph.reason.clone().unwrap_or_else(|| "Transcript graph is still indexing".into()),
            ));
        }
        let list = if let Some(group) = self.group {
            &graph.items.get(group).ok_or_else(|| DocError::Invalid("Unknown transcript group".into()))?.children
        } else {
            &graph.main
        };
        let visible: Vec<usize> =
            list.iter().copied().filter(|&id| self.events || graph.items[id].kind != "event").collect();
        let mut items = Vec::new();
        let mut bytes = 1024;
        for &id in visible.iter().skip(self.start).take(self.count) {
            let item = &graph.items[id];
            let entry = &graph.entries[item.entry];
            let turn = item.turn.and_then(|index| entry.turns.get(index));
            let content = turn
                .and_then(|turn| turn.content.as_ref())
                .map(|node| value(&c.raw, c.entry.generation, node))
                .transpose()?;
            let cost = 2048 + content.as_ref().map_or(0, |node| node.text.encode_utf16().count() * 6);
            if !items.is_empty() && bytes + cost > 192 << 10 {
                break;
            }
            bytes += cost;
            items.push(TranscriptItem {
                id: id as f64,
                kind: item.kind.into(),
                record: entry.line as f64,
                span: span(entry.span),
                root: value(&c.raw, c.entry.generation, &entry.root)?,
                role: turn.map(|turn| if turn.only_results { "tool".into() } else { turn.role.clone() }),
                timestamp: (!entry.timestamp.is_empty()).then(|| entry.timestamp.clone()),
                content,
                message_container: turn.map(|turn| turn.container),
                children: item.children.len() as f64,
                tools: turn.map_or(0, |turn| turn.calls.len()) as f64,
                linked_results: turn.map_or_else(Vec::new, |turn| {
                    turn.results.iter().filter(|result| result.linked).map(|result| span(result.block.span)).collect()
                }),
            });
        }
        let next = self.start + items.len();
        Ok(TranscriptPage {
            items,
            total: visible.len() as f64,
            next: (next < visible.len()).then_some(next as f64),
            events: graph.census.events as f64,
        })
    }
}
pub struct Tools {
    item: usize,
    call: Option<usize>,
    start: usize,
    count: usize,
}
impl Query for Tools {
    type Output = TranscriptTools;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let graph = c.index()?.transcript.lock().unwrap();
        let item = graph.items.get(self.item).ok_or_else(|| DocError::Invalid("Unknown transcript turn".into()))?;
        let turn = item
            .turn
            .and_then(|turn| graph.entries[item.entry].turns.get(turn))
            .ok_or_else(|| DocError::Invalid("Transcript item is not a turn".into()))?;
        let mut tools = Vec::new();
        let mut results = Vec::new();
        let mut bytes = 1024;
        let total;
        if let Some(call) = self.call {
            let call = turn.calls.get(call).ok_or_else(|| DocError::Invalid("Unknown transcript tool".into()))?;
            total = call.results.len();
            for result in call.results.iter().skip(self.start).take(self.count) {
                let entry = &graph.entries[result.entry];
                let result = &entry.turns[result.turn].results[result.result];
                let block = value(&c.raw, c.entry.generation, &result.block)?;
                let content =
                    result.content.as_ref().map(|node| value(&c.raw, c.entry.generation, node)).transpose()?;
                let cost = 2048
                    + (block.text.encode_utf16().count()
                        + content.as_ref().map_or(0, |node| node.text.encode_utf16().count()))
                        * 6;
                if !results.is_empty() && bytes + cost > 192 << 10 {
                    break;
                }
                bytes += cost;
                results.push(TranscriptResult { record: entry.line as f64, span: span(entry.span), block, content });
            }
        } else {
            total = turn.calls.len();
            for (ordinal, call) in turn.calls.iter().enumerate().skip(self.start).take(self.count) {
                let block = value(&c.raw, c.entry.generation, &call.block)?;
                let input = call.input.as_ref().map(|node| value(&c.raw, c.entry.generation, node)).transpose()?;
                let cost = 2048
                    + (block.text.encode_utf16().count()
                        + input.as_ref().map_or(0, |node| node.text.encode_utf16().count())
                        + call.id.len()
                        + call.name.len())
                        * 6;
                if !tools.is_empty() && bytes + cost > 192 << 10 {
                    break;
                }
                bytes += cost;
                tools.push(TranscriptTool {
                    ordinal: ordinal as f64,
                    name: call.name.clone(),
                    id: call.id.clone(),
                    block,
                    input,
                    results: call.results.len() as f64,
                });
            }
        }
        let next = self.start + tools.len() + results.len();
        Ok(TranscriptTools { tools, results, total: total as f64, next: (next < total).then_some(next as f64) })
    }
}
pub struct Text {
    start: u64,
    end: u64,
    block: usize,
}
impl Query for Text {
    type Output = TranscriptText;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        if self.end <= self.start || self.end - self.start > 65536 {
            return Err(DocError::Refused(
                "Transcript text block exceeds 64 KiB; inspect or copy its source in Rows".into(),
            ));
        }
        let bytes = c.raw.document().read(c.entry.generation, self.start, self.end)?;
        let decoded = c.raw.source_encoding().decode_without_bom_handling(&bytes).0;
        let text = String::from_utf8_lossy(&json::unescape(decoded.as_bytes())).into_owned();
        let rendered = typose_core::md::render_fragment(&text, &|| c.cancel.load(Ordering::Relaxed))?;
        let page = rendered.page(self.block, 128);
        let mut html = Vec::new();
        let mut bytes = 1024;
        for item in page {
            let cost = item.html.encode_utf16().count() * 6 + 128;
            if bytes + cost > 192 << 10 {
                if html.is_empty() {
                    return Err(DocError::Refused(
                        "Transcript Markdown block exceeds the bounded display limit; inspect its source in Rows"
                            .into(),
                    ));
                }
                break;
            }
            bytes += cost;
            html.push(item.html.to_string());
        }
        let next = self.block + html.len();
        Ok(TranscriptText {
            html,
            next: (next < rendered.items().len()).then_some(next as f64),
            total: rendered.items().len() as f64,
        })
    }
}
impl Doc {
    fn transcript_context(
        &self,
        generation: f64,
        revision: f64,
        cancel: &Cancel,
    ) -> std::result::Result<Context, Error<Code>> {
        let (raw, entry) = self.structured_entry(generation, revision)?;
        let charge = Reservation::new(core_structured::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(Context {
            raw,
            entry,
            owner: self.structured.clone(),
            cancel: cancel.flag.clone(),
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        })
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<TranscriptPage>")]
    #[allow(clippy::too_many_arguments, reason = "napi page request carries exact owner, range, cancel and group")]
    pub fn structured_transcript(
        &self,
        generation: f64,
        revision: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
        group: Option<f64>,
        events: Option<bool>,
    ) -> std::result::Result<AsyncTask<Read<Page>>, Error<Code>> {
        let count = int("count", count)? as usize;
        if count > 128 {
            return Err(Error::new(Code::InvalidParams, "Transcript count exceeds 128"));
        }
        Ok(AsyncTask::new(Read {
            context: self.transcript_context(generation, revision, cancel)?,
            query: Page {
                start: int("start", start)? as usize,
                count,
                group: group.map(|group| int("group", group).map(|value| value as usize)).transpose()?,
                events: events.unwrap_or(false),
            },
        }))
    }
    #[napi(ts_return_type = "Promise<TranscriptTools>")]
    #[allow(clippy::too_many_arguments, reason = "napi page request carries exact owner, range, cancel and call")]
    pub fn structured_transcript_tools(
        &self,
        generation: f64,
        revision: f64,
        item: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
        call: Option<f64>,
    ) -> std::result::Result<AsyncTask<Read<Tools>>, Error<Code>> {
        let count = int("count", count)? as usize;
        if count > 32 {
            return Err(Error::new(Code::InvalidParams, "Transcript tool count exceeds 32"));
        }
        Ok(AsyncTask::new(Read {
            context: self.transcript_context(generation, revision, cancel)?,
            query: Tools {
                item: int("item", item)? as usize,
                start: int("start", start)? as usize,
                count,
                call: call.map(|value| int("call", value).map(|value| value as usize)).transpose()?,
            },
        }))
    }
    #[napi(ts_return_type = "Promise<TranscriptText>")]
    pub fn structured_transcript_text(
        &self,
        generation: f64,
        revision: f64,
        start: f64,
        end: f64,
        block: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Read<Text>>, Error<Code>> {
        Ok(AsyncTask::new(Read {
            context: self.transcript_context(generation, revision, cancel)?,
            query: Text { start: int("start", start)?, end: int("end", end)?, block: int("block", block)? as usize },
        }))
    }
}
