//! Source-backed transcript metadata (brief §5.4). Payloads remain in the verified JSONL source: `observe` keeps each
//! record's spans and container ids as the JSONL index reads it, and `finish` builds the displayed order once the file
//! is indexed. Past a cap, the graph is off and Rows remains.
use crate::budget::Reservation;
use crate::json::{Child, JsonIndex, Kind, Span};
use crate::jsonl::{named_fields, read_string, visit_members};
use crate::store::{ByteStore, StoreError};
use std::collections::{HashMap, HashSet};

/// The most records a graph holds.
pub const MAX_ENTRIES: usize = 250_000;
/// A turn's tool calls and tool results, at most.
pub const MAX_CALLS: usize = 1024;
pub const MAX_RESULTS: usize = 128;
/// Item ids are below this (`limits`' `item` and `group` rows): a graph that could need more items is off.
pub const MAX_ITEMS: u64 = u32::MAX as u64;

#[derive(Clone, Debug)]
pub struct SourceRef {
    pub span: Span,
    pub kind: Kind,
    pub container: Option<u32>,
    pub children: u64,
}
fn reference(index: &JsonIndex, child: &Child) -> SourceRef {
    SourceRef {
        span: child.value,
        kind: child.kind,
        container: child.container,
        children: child.container.and_then(|id| index.containers.get(id as usize)).map_or(0, |node| node.children),
    }
}
#[derive(Clone, Debug)]
pub struct ResultLink {
    pub entry: usize,
    pub turn: usize,
    pub result: usize,
}
#[derive(Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub block: SourceRef,
    pub input: Option<SourceRef>,
    pub results: Vec<ResultLink>,
}
#[derive(Clone, Debug)]
pub struct ToolResult {
    pub id: String,
    pub block: SourceRef,
    pub content: Option<SourceRef>,
    pub linked: bool,
}
#[derive(Clone, Debug)]
pub struct Turn {
    pub role: String,
    pub content: Option<SourceRef>,
    pub container: u32,
    pub calls: Vec<ToolCall>,
    pub results: Vec<ToolResult>,
    pub only_results: bool,
}
#[derive(Clone, Debug)]
pub struct Entry {
    pub line: u64,
    pub span: Span,
    pub root: SourceRef,
    pub schema: &'static str,
    pub turns: Vec<Turn>,
    pub timestamp: String,
    pub uuid: Option<String>,
    pub parent: Option<String>,
    pub sidechain: bool,
}
#[derive(Clone, Debug)]
pub struct Item {
    pub kind: &'static str,
    pub entry: usize,
    pub turn: Option<usize>,
    pub children: Vec<usize>,
}
#[derive(Default, Clone)]
pub struct Census {
    pub messages: u64,
    pub events: u64,
    pub branches: u64,
    pub sidechains: u64,
    pub calls: u64,
    pub matched_results: u64,
    pub unmatched_results: u64,
}
pub struct Graph {
    pub entries: Vec<Entry>,
    pub items: Vec<Item>,
    pub main: Vec<usize>,
    pub ready: bool,
    pub reason: Option<String>,
    pub schema: Option<&'static str>,
    pub census: Census,
    charge: Reservation,
}
impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}
impl Graph {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            items: Vec::new(),
            main: Vec::new(),
            ready: false,
            reason: None,
            schema: None,
            census: Census::default(),
            charge: Reservation::none(),
        }
    }
    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }
    fn disable(&mut self, reason: &str) {
        self.reason = Some(reason.into());
        self.entries.clear();
        self.entries.shrink_to_fit();
        self.items.clear();
        self.main.clear();
        self.charge = Reservation::none();
    }
    pub fn observe(&mut self, store: &ByteStore, index: &JsonIndex, line: u64, span: Span) -> Result<(), StoreError> {
        if self.reason.is_some() {
            return Ok(());
        }
        let Some((kind, root_span)) = index.root else {
            return Ok(());
        };
        let fields = named_fields(
            store,
            index,
            0,
            &[
                "type",
                "message",
                "uuid",
                "parentUuid",
                "isSidechain",
                "timestamp",
                "messages",
                "role",
                "content",
                "tool_calls",
                "tool_call_id",
                "function_call",
                "name",
            ],
        )?;
        let string = |name: &str| -> Result<Option<String>, StoreError> {
            fields
                .get(name)
                .filter(|node| node.kind == Kind::String)
                .map(|node| read_string(store, node.value))
                .transpose()
        };
        let mut entry = Entry {
            line,
            span,
            root: SourceRef {
                span: root_span,
                kind,
                container: matches!(kind, Kind::Object | Kind::Array).then_some(0),
                children: index.containers.get(0).map_or(0, |node| node.children),
            },
            schema: "event",
            turns: Vec::new(),
            timestamp: string("timestamp")?.unwrap_or_default(),
            uuid: string("uuid")?,
            parent: string("parentUuid")?,
            sidechain: fields.get("isSidechain").is_some_and(|node| node.kind == Kind::True),
        };
        if entry.uuid.as_ref().is_some_and(|value| value.len() >= 4094)
            || entry.parent.as_ref().is_some_and(|value| value.len() >= 4094)
        {
            self.disable("A transcript graph ID exceeds its metadata limit; Rows preserves the source");
            return Ok(());
        }
        let event_type = string("type")?.unwrap_or_default();
        if matches!(event_type.as_str(), "user" | "assistant")
            && let Some(container) =
                fields.get("message").filter(|node| node.kind == Kind::Object).and_then(|node| node.container)
        {
            entry.schema = "claude-code-v1";
            entry.turns.push(turn(store, index, container, true)?);
        } else if let Some(container) =
            fields.get("messages").filter(|node| node.kind == Kind::Array).and_then(|node| node.container)
        {
            entry.schema = "openai-dataset-v1";
            visit_members(store, index, container, |message| {
                if let Some(container) = message.container.filter(|_| message.kind == Kind::Object) {
                    entry.turns.push(turn(store, index, container, false)?);
                }
                Ok(true)
            })?;
        } else if string("role")?.is_some_and(|role| crate::jsonl::known_role(&role)) && fields.contains_key("content")
        {
            entry.schema = "openai-chat-v1";
            entry.turns.push(turn(store, index, 0, false)?);
        }
        if entry.turns.iter().any(|turn| turn.results.len() > MAX_RESULTS || turn.calls.len() > MAX_CALLS) {
            self.disable("A turn exceeds the bounded Transcript tool metadata limit; Rows preserves every block");
            return Ok(());
        }
        if self.entries.len() >= MAX_ENTRIES || self.charge.grow(estimate(&entry)).is_err() {
            self.disable("Transcript graph exceeds its memory or record limit; Rows remains available");
            return Ok(());
        }
        self.entries.push(entry);
        Ok(())
    }
    pub fn reject_undetected(&mut self) {
        self.disable("No supported transcript schema was detected in the first 200 parsed records");
    }
    pub fn finish(&mut self, schema: Option<&'static str>) {
        if self.reason.is_some() {
            return;
        }
        let Some(schema) = schema else {
            self.reject_undetected();
            return;
        };
        self.schema = Some(schema);
        if schema == "claude-code-v1" {
            self.drop_copies();
        }
        // Each item is a turn or stands for a record (an event, a conversation, a group rooted at it).
        let turns: usize = self.entries.iter().map(|entry| entry.turns.len()).sum();
        if (self.entries.len() + turns) as u64 > MAX_ITEMS {
            self.disable("Transcript graph exceeds its item limit; Rows remains available");
            return;
        }
        if self.charge.grow(self.entries.len() as u64 * 4096).is_err() {
            self.disable("Transcript graph finalization exceeds its memory budget; Rows remains available");
            return;
        }
        self.match_tools(schema);
        if schema == "claude-code-v1" {
            self.claude();
        } else {
            self.openai(schema);
        }
        self.ready = self.reason.is_none();
    }
    /// Claude Code writes some records twice. On this PC (M5 PR 1), 10 of 274 sessions hold 12,351 later copies of
    /// earlier records, in runs that each follow a `bridge-session` or `pr-link` record; every later copy is timestamped
    /// before a record already written. The copies differ in metadata only (`slug`, `promptId`, `toolUseResult`,
    /// `version`, `message.usage`), never in role or content. Where their `parentUuid`s differ (279 copies), the later
    /// one mostly points at the copy before it in its run. So the first copy is the record, in its place in time and in
    /// the file; later copies leave the graph, with what they were charged.
    fn drop_copies(&mut self) {
        let mut seen = HashSet::with_capacity(self.entries.len());
        let keep: Vec<bool> =
            self.entries.iter().map(|entry| entry.uuid.as_deref().is_none_or(|uuid| seen.insert(uuid))).collect();
        drop(seen);
        let (mut at, mut freed) = (0, 0);
        self.entries.retain(|entry| {
            at += 1;
            freed += if keep[at - 1] { 0 } else { estimate(entry) };
            keep[at - 1]
        });
        self.charge.shrink(freed);
    }
    fn item(&mut self, kind: &'static str, entry: usize, turn: Option<usize>, children: Vec<usize>) -> usize {
        let id = self.items.len();
        self.items.push(Item { kind, entry, turn, children });
        id
    }
    fn turn_items(&mut self, entry: usize) -> Vec<usize> {
        let count = self.entries[entry].turns.len();
        let mut items = Vec::new();
        for index in 0..count {
            let turn = &self.entries[entry].turns[index];
            if turn.only_results && turn.results.iter().all(|result| result.linked) {
                continue;
            }
            items.push(self.item("turn", entry, Some(index), Vec::new()));
        }
        items
    }
    fn match_tools(&mut self, schema: &str) {
        let mut calls = HashMap::new();
        let mut results = Vec::new();
        for (entry_index, entry) in self.entries.iter().enumerate() {
            if !same_schema(entry.schema, schema) {
                continue;
            }
            for (turn_index, turn) in entry.turns.iter().enumerate() {
                self.census.messages += 1;
                let prefix = if entry.schema == "openai-dataset-v1" { entry_index + 1 } else { 0 };
                for (call_index, call) in turn.calls.iter().enumerate() {
                    if !call.id.is_empty() {
                        calls.insert((prefix, call.id.clone()), (entry_index, turn_index, call_index));
                    }
                    self.census.calls += 1;
                }
                for (result_index, result) in turn.results.iter().enumerate() {
                    results.push((prefix, entry_index, turn_index, result_index, result.id.clone()));
                }
            }
        }
        for (prefix, entry, turn, result, id) in results {
            if let Some(&(caller, caller_turn, call)) = calls.get(&(prefix, id)) {
                self.entries[caller].turns[caller_turn].calls[call].results.push(ResultLink { entry, turn, result });
                self.entries[entry].turns[turn].results[result].linked = true;
                self.census.matched_results += 1;
            } else {
                self.census.unmatched_results += 1;
            }
        }
    }
    fn openai(&mut self, schema: &str) {
        for entry in 0..self.entries.len() {
            if same_schema(self.entries[entry].schema, schema) {
                let turns = self.turn_items(entry);
                if self.entries[entry].schema == "openai-dataset-v1" {
                    let item = self.item("conversation", entry, None, turns);
                    self.main.push(item);
                } else {
                    self.main.extend(turns);
                }
            } else {
                self.census.events += 1;
                let item = self.item("event", entry, None, Vec::new());
                self.main.push(item);
            }
        }
    }
    fn claude(&mut self) {
        let mut ids = HashMap::new();
        let mut messages = Vec::new();
        let mut events = Vec::new();
        for (index, entry) in self.entries.iter().enumerate() {
            if let Some(uuid) = &entry.uuid {
                ids.insert(uuid.clone(), index); // unique: `drop_copies` ran
            }
            if entry.schema == "claude-code-v1" {
                messages.push(index);
            } else {
                events.push(index);
            }
        }
        self.census.events = events.len() as u64;
        // Session events may carry UUIDs and sit between two messages in the parent chain.
        let direct: Vec<Option<usize>> =
            self.entries.iter().map(|entry| entry.parent.as_ref().and_then(|id| ids.get(id)).copied()).collect();
        let mut parents = vec![None; self.entries.len()];
        for &message in &messages {
            let mut current = direct[message];
            let mut visited = HashSet::new();
            while let Some(index) = current {
                if !visited.insert(index) {
                    self.disable("Transcript parent graph contains an event cycle; inspect in Rows");
                    return;
                }
                if self.entries[index].schema == "claude-code-v1" {
                    break;
                }
                current = direct[index];
            }
            parents[message] = current;
        }
        let parent = |index: usize| parents[index];
        // A subagent's own session is all sidechain (every agent-*.jsonl on this PC, 2,712 of 2,986 session files):
        // with no main chain to attach to, its sidechain is the chain, ending at its latest leaf like any other.
        let sidechain_only = messages.iter().all(|&index| self.entries[index].sidechain);
        let side: Vec<bool> = self.entries.iter().map(|entry| entry.sidechain && !sidechain_only).collect();
        let mut has_child = HashSet::new();
        for &index in &messages {
            if !side[index]
                && let Some(parent) = parent(index)
            {
                has_child.insert(parent);
            }
        }
        let leaf = messages.iter().rev().find(|&&index| !side[index] && !has_child.contains(&index)).copied();
        let Some(mut current) = leaf else {
            self.disable("Transcript has no leaf message; inspect its graph in Rows");
            return;
        };
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current) {
                self.disable("Transcript parent graph contains a cycle; inspect in Rows");
                return;
            }
            chain.push(current);
            let Some(next) = parent(current) else {
                break;
            };
            current = next;
        }
        chain.reverse();
        let chain_set: HashSet<usize> = chain.iter().copied().collect();
        let mut branches: HashMap<(Option<usize>, usize), Vec<usize>> = HashMap::new();
        let mut sides: HashMap<(Option<usize>, usize), Vec<usize>> = HashMap::new();
        for &index in &messages {
            if chain_set.contains(&index) {
                continue;
            }
            let sidechain = side[index];
            let mut attach = parent(index);
            let mut root = index;
            let mut visited = HashSet::new();
            while let Some(ancestor) = attach {
                if !visited.insert(ancestor) {
                    self.disable("Transcript parent graph contains a cycle; inspect in Rows");
                    return;
                }
                if sidechain {
                    if !side[ancestor] {
                        break;
                    }
                } else if chain_set.contains(&ancestor) {
                    break;
                }
                root = ancestor;
                attach = parent(ancestor);
            }
            (if sidechain { &mut sides } else { &mut branches }).entry((attach, root)).or_default().push(index);
        }
        let mut side_items: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
        let mut sides: Vec<_> = sides.into_iter().collect();
        sides.sort_by_key(|((_, root), _)| *root);
        for ((attach, _), entries) in sides {
            let first = entries[0];
            let mut children = Vec::new();
            for entry in entries {
                children.extend(self.turn_items(entry));
            }
            self.census.sidechains += 1;
            let item = self.item("sidechain", first, None, children);
            side_items.entry(attach).or_default().push(item);
        }
        let mut branch_items: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
        let mut branches: Vec<_> = branches.into_iter().collect();
        branches.sort_by_key(|((_, root), _)| *root);
        for ((attach, _), entries) in branches {
            let first = entries[0];
            let mut children = Vec::new();
            for entry in entries {
                children.extend(self.turn_items(entry));
                if let Some(side) = side_items.remove(&Some(entry)) {
                    children.extend(side);
                }
            }
            self.census.branches += 1;
            let item = self.item("branch", first, None, children);
            branch_items.entry(attach).or_default().push(item);
        }
        if let Some(branch) = branch_items.remove(&None) {
            self.main.extend(branch);
        }
        if let Some(side) = side_items.remove(&None) {
            self.main.extend(side);
        }
        let mut event_at = 0;
        for entry in chain {
            while event_at < events.len() && events[event_at] < entry {
                let item = self.item("event", events[event_at], None, Vec::new());
                self.main.push(item);
                event_at += 1;
            }
            let turns = self.turn_items(entry);
            self.main.extend(turns);
            if let Some(branch) = branch_items.remove(&Some(entry)) {
                self.main.extend(branch);
            }
            if let Some(side) = side_items.remove(&Some(entry)) {
                self.main.extend(side);
            }
        }
        while event_at < events.len() {
            let item = self.item("event", events[event_at], None, Vec::new());
            self.main.push(item);
            event_at += 1;
        }
        self.main.extend(branch_items.into_values().flatten());
        self.main.extend(side_items.into_values().flatten());
    }
}
/// What an entry is charged.
fn estimate(entry: &Entry) -> u64 {
    let mut bytes = 2048
        + (entry.timestamp.len()
            + entry.uuid.as_ref().map_or(0, String::len)
            + entry.parent.as_ref().map_or(0, String::len)) as u64
            * 8;
    for turn in &entry.turns {
        bytes += 2048 + turn.role.len() as u64 * 8;
        for call in &turn.calls {
            bytes += 2048 + (call.id.len() + call.name.len()) as u64 * 8;
        }
        for result in &turn.results {
            bytes += 1024 + result.id.len() as u64 * 8;
        }
    }
    bytes
}
fn same_schema(entry: &str, schema: &str) -> bool {
    entry == schema || entry.starts_with("openai-") && schema.starts_with("openai-")
}
fn turn(store: &ByteStore, index: &JsonIndex, container: u32, claude: bool) -> Result<Turn, StoreError> {
    let fields = named_fields(
        store,
        index,
        container,
        &["role", "content", "tool_calls", "tool_call_id", "function_call", "name"],
    )?;
    let string = |name: &str| {
        fields.get(name).filter(|node| node.kind == Kind::String).map(|node| read_string(store, node.value)).transpose()
    };
    let role = string("role")?.unwrap_or_else(|| "unknown".into());
    let content = fields.get("content").map(|node| reference(index, node));
    let mut turn = Turn { role, content, container, calls: Vec::new(), results: Vec::new(), only_results: false };
    if claude {
        if let Some(content) = &turn.content
            && let Some(array) = content.container.filter(|_| content.kind == Kind::Array)
        {
            let mut blocks = 0;
            visit_members(store, index, array, |block| {
                blocks += 1;
                if let Some(object) = block.container.filter(|_| block.kind == Kind::Object) {
                    let fields =
                        named_fields(store, index, object, &["type", "id", "name", "input", "tool_use_id", "content"])?;
                    let string = |name: &str| {
                        fields
                            .get(name)
                            .filter(|node| node.kind == Kind::String)
                            .map(|node| read_string(store, node.value))
                            .transpose()
                    };
                    match string("type")?.as_deref() {
                        Some("tool_use") => turn.calls.push(ToolCall {
                            id: string("id")?.unwrap_or_default(),
                            name: string("name")?.unwrap_or_else(|| "Tool".into()),
                            block: reference(index, &block),
                            input: fields.get("input").map(|node| reference(index, node)),
                            results: Vec::new(),
                        }),
                        Some("tool_result") => turn.results.push(ToolResult {
                            id: string("tool_use_id")?.unwrap_or_default(),
                            block: reference(index, &block),
                            content: fields.get("content").map(|node| reference(index, node)),
                            linked: false,
                        }),
                        _ => {}
                    }
                }
                Ok(true)
            })?;
            turn.only_results = blocks > 0 && blocks == turn.results.len();
        }
    } else {
        if let Some(calls) = fields.get("tool_calls").and_then(|node| node.container) {
            visit_members(store, index, calls, |call| {
                if let Some(object) = call.container {
                    let fields = named_fields(store, index, object, &["id", "function"])?;
                    let id =
                        fields.get("id").map(|node| read_string(store, node.value)).transpose()?.unwrap_or_default();
                    if let Some(function) = fields.get("function").and_then(|node| node.container) {
                        let fields = named_fields(store, index, function, &["name", "arguments"])?;
                        let name = fields
                            .get("name")
                            .map(|node| read_string(store, node.value))
                            .transpose()?
                            .unwrap_or_else(|| "Tool".into());
                        turn.calls.push(ToolCall {
                            id,
                            name,
                            block: reference(index, &call),
                            input: fields.get("arguments").map(|node| reference(index, node)),
                            results: Vec::new(),
                        });
                    }
                }
                Ok(true)
            })?;
        }
        if matches!(turn.role.as_str(), "tool" | "function") {
            let id = string("tool_call_id")?
                .or_else(|| string("name").ok().flatten().map(|name| format!("function:{name}")))
                .unwrap_or_default();
            if let Some(content) = &turn.content {
                turn.results.push(ToolResult {
                    id,
                    block: content.clone(),
                    content: Some(content.clone()),
                    linked: false,
                });
                turn.only_results = true;
            }
        }
        if let Some(function) = fields.get("function_call").and_then(|node| node.container) {
            let fields = named_fields(store, index, function, &["name", "arguments"])?;
            let name = fields
                .get("name")
                .map(|node| read_string(store, node.value))
                .transpose()?
                .unwrap_or_else(|| "Tool".into());
            let block = fields.get("arguments").map(|node| reference(index, node));
            if let Some(block) = block {
                turn.calls.push(ToolCall {
                    id: format!("function:{name}"),
                    name,
                    block: block.clone(),
                    input: Some(block),
                    results: Vec::new(),
                });
            }
        }
    }
    Ok(turn)
}

#[cfg(test)]
mod tests {
    use crate::{budget::Reservation, doc::Document, jsonl::Index, store::testutil::temp_file};
    fn fixture(name: &str, lines: &[&str]) -> Index {
        let file = temp_file(name, lines.join("\n").as_bytes());
        let doc = Document::open(&file).unwrap();
        let index = Index::with_encoding(encoding_rs::UTF_8).unwrap();
        index.build_reserved(&doc, 1, Reservation::none()).unwrap();
        index
    }
    #[test]
    fn claude_latest_leaf_keeps_branches_sidechains_events_and_tool_result_links() {
        let index = fixture(
            "transcript-claude-graph",
            &[
                r#"{"type":"user","uuid":"u0","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"start"}]}}"#,
                r#"{"type":"assistant","uuid":"a1","parentUuid":"u0","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read","input":{"path":"file.md"}}]}}"#,
                r#"{"type":"user","uuid":"u1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"result"}]}}"#,
                r#"{"type":"assistant","uuid":"old","parentUuid":"u1","message":{"role":"assistant","content":"old branch"}}"#,
                r#"{"type":"assistant","uuid":"new","parentUuid":"u1","message":{"role":"assistant","content":"latest leaf"}}"#,
                r#"{"type":"assistant","uuid":"s1","parentUuid":"a1","isSidechain":true,"message":{"role":"assistant","content":"sidechain"}}"#,
                r#"{"type":"file-history-snapshot","snapshot":{"safe":true}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready);
        assert_eq!(graph.schema, Some("claude-code-v1"));
        assert_eq!(graph.census.messages, 6);
        assert_eq!(graph.census.events, 1);
        assert_eq!(graph.census.branches, 1);
        assert_eq!(graph.census.sidechains, 1);
        assert_eq!(graph.census.calls, 1);
        assert_eq!(graph.census.matched_results, 1);
        let shown: Vec<_> = graph
            .main
            .iter()
            .filter_map(|&id| {
                let item = &graph.items[id];
                (item.kind == "turn").then(|| graph.entries[item.entry].uuid.as_deref().unwrap())
            })
            .collect();
        assert_eq!(shown, vec!["u0", "a1", "new"]);
        assert_eq!(graph.entries[1].turns[0].calls[0].results[0].entry, 2);
        assert!(graph.entries[2].turns[0].results[0].linked);
    }
    #[test]
    fn openai_message_results_nest_and_orphans_remain_visible() {
        let index = fixture(
            "transcript-openai-links",
            &[
                r#"{"role":"user","content":"question"}"#,
                r#"{"role":"assistant","content":null,"tool_calls":[{"id":"t","type":"function","function":{"name":"lookup","arguments":"{\"n\":3.10}"}}]}"#,
                r#"{"role":"tool","tool_call_id":"t","content":"answer"}"#,
                r#"{"role":"tool","tool_call_id":"missing","content":"orphan"}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready);
        assert_eq!(graph.census.matched_results, 1);
        assert_eq!(graph.census.unmatched_results, 1);
        assert_eq!(graph.main.len(), 3);
    }
    #[test]
    fn dataset_lines_stay_separate_and_reused_call_ids_do_not_cross_conversations() {
        let line = r#"{"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"t","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"t","content":"answer"}],"metadata":{"source":"fixture"}}"#;
        let index = fixture("transcript-openai-dataset", &[line, line, line]);
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready);
        assert_eq!(graph.main.len(), 3);
        assert!(graph.main.iter().all(|&id| graph.items[id].kind == "conversation"));
        assert_eq!(graph.census.matched_results, 3);
        for entry in &graph.entries {
            assert_eq!(entry.turns[0].calls[0].results.len(), 1);
        }
    }
    #[test]
    fn generic_jsonl_does_not_retain_a_transcript_graph() {
        let index = fixture("transcript-generic", &[r#"{"message":"hello"}"#]);
        let graph = index.transcript.lock().unwrap();
        assert!(!graph.ready);
        assert!(graph.entries.is_empty());
        assert_eq!(graph.charged(), 0);
    }
    #[test]
    fn event_uuid_intermediates_keep_a_straight_message_chain_and_zero_branches() {
        let index = fixture(
            "transcript-event-intermediates",
            &[
                r#"{"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
                r#"{"type":"system","uuid":"event1","parentUuid":"u"}"#,
                r#"{"type":"assistant","uuid":"a","parentUuid":"event1","message":{"role":"assistant","content":"reply"}}"#,
                r#"{"type":"progress","uuid":"event2","parentUuid":"a"}"#,
                r#"{"type":"user","uuid":"last","parentUuid":"event2","message":{"role":"user","content":"finish"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready);
        assert_eq!(graph.census.messages, 3);
        assert_eq!(graph.census.events, 2);
        assert_eq!(graph.census.branches, 0);
        let shown: Vec<_> = graph
            .main
            .iter()
            .filter_map(|&id| {
                let item = &graph.items[id];
                (item.kind == "turn").then(|| graph.entries[item.entry].uuid.as_deref().unwrap())
            })
            .collect();
        assert_eq!(shown, vec!["u", "a", "last"]);
    }
    #[test]
    fn distinct_off_chain_roots_at_the_same_fork_get_distinct_branch_groups() {
        let index = fixture(
            "transcript-distinct-branches",
            &[
                r#"{"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
                r#"{"type":"system","uuid":"event","parentUuid":"u"}"#,
                r#"{"type":"assistant","uuid":"old1","parentUuid":"event","message":{"role":"assistant","content":"branch one"}}"#,
                r#"{"type":"assistant","uuid":"old2","parentUuid":"event","message":{"role":"assistant","content":"branch two"}}"#,
                r#"{"type":"assistant","uuid":"new","parentUuid":"event","message":{"role":"assistant","content":"latest leaf"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready);
        assert_eq!(graph.census.branches, 2);
        assert_eq!(graph.main.iter().filter(|&&id| graph.items[id].kind == "branch").count(), 2);
    }
    /// A session that wrote records twice (`drop_copies`): the first copies keep their place, the rerun adds nothing,
    /// and what follows it extends the one chain.
    #[test]
    fn a_record_written_twice_keeps_its_first_copy() {
        let a1 = r#"{"type":"assistant","uuid":"a1","parentUuid":"u0","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#;
        let a1_copy = a1.replace(r#""message""#, r#""slug":"rerun","message""#);
        let index = fixture(
            "transcript-copies",
            &[
                r#"{"type":"user","uuid":"u0","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
                a1,
                r#"{"type":"user","uuid":"u1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"result"}]}}"#,
                r#"{"type":"assistant","uuid":"a2","parentUuid":"u1","message":{"role":"assistant","content":"answer"}}"#,
                r#"{"type":"bridge-session","sessionId":"s"}"#,
                r#"{"type":"user","uuid":"u0","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
                &a1_copy,
                r#"{"type":"user","uuid":"u1","parentUuid":"u0","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"result"}]}}"#,
                r#"{"type":"user","uuid":"u2","parentUuid":"a2","message":{"role":"user","content":"next"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        let c = &graph.census;
        assert_eq!((c.messages, c.events, c.branches, c.calls, c.matched_results), (5, 1, 0, 1, 1));
        let shown: Vec<_> = graph
            .main
            .iter()
            .filter_map(|&id| {
                let item = &graph.items[id];
                let entry = &graph.entries[item.entry];
                (item.kind == "turn").then(|| (entry.uuid.as_deref().unwrap(), entry.line))
            })
            .collect();
        assert_eq!(shown, vec![("u0", 0), ("a1", 1), ("a2", 3), ("u2", 8)]);
        let call = graph.entries.iter().find(|entry| entry.uuid.as_deref() == Some("a1")).unwrap();
        assert_eq!(call.line, 1);
        assert_eq!(graph.entries[call.turns[0].calls[0].results[0].entry].line, 2);
    }
    /// A subagent's session, all sidechain: its latest leaf's chain is the main one, with the branch it left at the
    /// fork, not one collapsed sidechain group.
    #[test]
    fn a_sidechain_only_session_reads_as_its_own_chain() {
        let index = fixture(
            "transcript-subagent",
            &[
                r#"{"type":"user","uuid":"s0","parentUuid":null,"isSidechain":true,"message":{"role":"user","content":"task"}}"#,
                r#"{"type":"assistant","uuid":"s1","parentUuid":"s0","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"grep","input":{}}]}}"#,
                r#"{"type":"user","uuid":"s2","parentUuid":"s1","isSidechain":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"hit"}]}}"#,
                r#"{"type":"assistant","uuid":"old","parentUuid":"s2","isSidechain":true,"message":{"role":"assistant","content":"retry"}}"#,
                r#"{"type":"assistant","uuid":"s3","parentUuid":"s2","isSidechain":true,"message":{"role":"assistant","content":"done"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        assert_eq!((graph.census.messages, graph.census.branches, graph.census.sidechains), (5, 1, 0));
        let shown: Vec<_> = graph
            .main
            .iter()
            .map(|&id| {
                let item = &graph.items[id];
                (item.kind, graph.entries[item.entry].uuid.as_deref().unwrap())
            })
            .collect();
        assert_eq!(shown, vec![("turn", "s0"), ("turn", "s1"), ("branch", "old"), ("turn", "s3")]);
    }
}
