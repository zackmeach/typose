//! Source-backed transcript metadata (brief §5.4). Payloads remain in the verified JSONL source: `observe` keeps each
//! record's spans and container ids as the JSONL index reads it, and `finish` builds the displayed order once the file
//! is indexed. Past a cap, the graph is off and Rows remains.
use crate::budget::Reservation;
use crate::doc::DocError;
use crate::json::{Child, JsonIndex, Kind, Span};
use crate::jsonl::{named_fields, read_string, visit_members};
use crate::store::{ByteStore, StoreError, cancelled};
use std::collections::{HashMap, HashSet};

/// The most records a graph holds.
pub const MAX_ENTRIES: usize = 250_000;
/// A turn's tool calls and tool results, at most.
pub const MAX_CALLS: usize = 1024;
pub const MAX_RESULTS: usize = 128;
/// Item ids are below this (`limits`' `item` and `group` rows): a graph that could need more items is off.
pub const MAX_ITEMS: u64 = u32::MAX as u64;
/// `finish` checks its cancel flag this often, in steps.
const CANCEL_EVERY: u64 = 4096;

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
    /// The last `finish`'s steps, which a test bounds: they're linear in the graph.
    pub steps: u64,
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
            steps: 0,
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
    /// Builds the displayed order once every record is observed: linear in the graph's records, turns and links, and
    /// cancellable, checking the read's flag (`store::cancellable`) every `CANCEL_EVERY` steps. A cancelled finish
    /// leaves the graph off.
    pub fn finish(&mut self, schema: Option<&'static str>) -> Result<(), DocError> {
        if self.reason.is_some() {
            return Ok(());
        }
        let Some(schema) = schema else {
            self.reject_undetected();
            return Ok(());
        };
        self.schema = Some(schema);
        let mut steps = Steps(0);
        let built = self.build(schema, &mut steps);
        self.steps = steps.0;
        match built {
            Ok(()) => self.ready = true,
            Err(Stop::Off(reason)) => self.disable(reason),
            Err(Stop::Cancelled) => {
                self.disable("Transcript indexing was cancelled");
                return Err(DocError::Cancelled);
            }
        }
        Ok(())
    }
    fn build(&mut self, schema: &'static str, steps: &mut Steps) -> Result<(), Stop> {
        if schema == "claude-code-v1" {
            self.drop_copies(steps)?;
        }
        // Each item is a turn or stands for a record (an event, a conversation, a group rooted at it).
        let turns: usize = self.entries.iter().map(|entry| entry.turns.len()).sum();
        if (self.entries.len() + turns) as u64 > MAX_ITEMS {
            return Err(Stop::Off("Transcript graph exceeds its item limit; Rows remains available"));
        }
        if self.charge.grow(self.entries.len() as u64 * 4096).is_err() {
            return Err(Stop::Off("Transcript graph finalization exceeds its memory budget; Rows remains available"));
        }
        self.match_tools(schema, steps)?;
        if schema == "claude-code-v1" { self.claude(steps) } else { self.openai(schema, steps) }
    }
    /// Claude Code writes some records twice. On this PC (M5 PR 1), 10 of 274 sessions hold 12,351 later copies of
    /// earlier records, in runs that each follow a `bridge-session` or `pr-link` record; every later copy is timestamped
    /// before a record already written. The copies differ in metadata only (`slug`, `promptId`, `toolUseResult`,
    /// `version`, `message.usage`), never in role or content. Where their `parentUuid`s differ (279 copies), the later
    /// one mostly points at the copy before it in its run. So the first copy is the record, in its place in time and in
    /// the file; later copies leave the graph, with what they were charged.
    fn drop_copies(&mut self, steps: &mut Steps) -> Result<(), Stop> {
        let mut seen = HashSet::with_capacity(self.entries.len());
        let mut keep = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            steps.tick()?;
            keep.push(entry.uuid.as_deref().is_none_or(|uuid| seen.insert(uuid)));
        }
        drop(seen);
        let (mut at, mut freed) = (0, 0);
        self.entries.retain(|entry| {
            at += 1;
            freed += if keep[at - 1] { 0 } else { estimate(entry) };
            keep[at - 1]
        });
        self.charge.shrink(freed);
        Ok(())
    }
    fn item(&mut self, kind: &'static str, entry: usize, turn: Option<usize>, children: Vec<usize>) -> usize {
        let id = self.items.len();
        self.items.push(Item { kind, entry, turn, children });
        id
    }
    fn turn_items(&mut self, entry: usize, steps: &mut Steps) -> Result<Vec<usize>, Stop> {
        let count = self.entries[entry].turns.len();
        let mut items = Vec::new();
        for index in 0..count {
            steps.tick()?;
            let turn = &self.entries[entry].turns[index];
            if turn.only_results && turn.results.iter().all(|result| result.linked) {
                continue;
            }
            items.push(self.item("turn", entry, Some(index), Vec::new()));
        }
        Ok(items)
    }
    fn match_tools(&mut self, schema: &str, steps: &mut Steps) -> Result<(), Stop> {
        let mut calls = HashMap::new();
        let mut results = Vec::new();
        for (entry_index, entry) in self.entries.iter().enumerate() {
            steps.tick()?;
            if !same_schema(entry.schema, schema) {
                continue;
            }
            for (turn_index, turn) in entry.turns.iter().enumerate() {
                steps.tick()?;
                self.census.messages += 1;
                let prefix = if entry.schema == "openai-dataset-v1" { entry_index + 1 } else { 0 };
                for (call_index, call) in turn.calls.iter().enumerate() {
                    steps.tick()?;
                    if !call.id.is_empty() {
                        calls.insert((prefix, call.id.clone()), (entry_index, turn_index, call_index));
                    }
                    self.census.calls += 1;
                }
                for (result_index, result) in turn.results.iter().enumerate() {
                    steps.tick()?;
                    results.push((prefix, entry_index, turn_index, result_index, result.id.clone()));
                }
            }
        }
        for (prefix, entry, turn, result, id) in results {
            steps.tick()?;
            if let Some(&(caller, caller_turn, call)) = calls.get(&(prefix, id)) {
                self.entries[caller].turns[caller_turn].calls[call].results.push(ResultLink { entry, turn, result });
                self.entries[entry].turns[turn].results[result].linked = true;
                self.census.matched_results += 1;
            } else {
                self.census.unmatched_results += 1;
            }
        }
        Ok(())
    }
    fn openai(&mut self, schema: &str, steps: &mut Steps) -> Result<(), Stop> {
        for entry in 0..self.entries.len() {
            steps.tick()?;
            if same_schema(self.entries[entry].schema, schema) {
                let turns = self.turn_items(entry, steps)?;
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
        Ok(())
    }
    fn claude(&mut self, steps: &mut Steps) -> Result<(), Stop> {
        let n = self.entries.len();
        let message: Vec<bool> = self.entries.iter().map(|entry| entry.schema == "claude-code-v1").collect();
        let messages: Vec<usize> = (0..n).filter(|&index| message[index]).collect();
        let events: Vec<usize> = (0..n).filter(|&index| !message[index]).collect();
        self.census.events = events.len() as u64;
        let mut ids = HashMap::with_capacity(n);
        for (index, entry) in self.entries.iter().enumerate() {
            steps.tick()?;
            if let Some(uuid) = &entry.uuid {
                ids.insert(uuid.as_str(), index); // unique: `drop_copies` ran
            }
        }
        let mut direct = Vec::with_capacity(n);
        for entry in &self.entries {
            steps.tick()?;
            direct.push(entry.parent.as_deref().and_then(|id| ids.get(id).copied()));
        }
        drop(ids);
        // Session events may carry UUIDs and sit between two messages: a message's parent is the nearest message above.
        let mut memo = vec![Climb::Unknown; n];
        let mut path = Vec::with_capacity(n);
        let mut parents = vec![None; n];
        for &index in &messages {
            let found = climb(index, &mut memo, &mut path, |at| direct[at], |at| message[at], steps)?;
            parents[index] =
                found.ok_or(Stop::Off("Transcript parent graph contains an event cycle; inspect in Rows"))?.0;
        }
        // A subagent's own session is all sidechain (every agent-*.jsonl on this PC, 2,712 of 2,986 session files):
        // with no main chain to attach to, its sidechain is the chain, ending at its latest leaf like any other.
        let sidechain_only = messages.iter().all(|&index| self.entries[index].sidechain);
        let side: Vec<bool> = self.entries.iter().map(|entry| entry.sidechain && !sidechain_only).collect();
        let mut has_child = vec![false; n];
        for &index in &messages {
            if !side[index]
                && let Some(parent) = parents[index]
            {
                has_child[parent] = true;
            }
        }
        let leaf = messages.iter().rev().find(|&&index| !side[index] && !has_child[index]).copied();
        let mut at = Some(leaf.ok_or(Stop::Off("Transcript has no leaf message; inspect its graph in Rows"))?);
        let mut on_chain = vec![false; n];
        let mut chain = Vec::new();
        while let Some(index) = at {
            steps.tick()?;
            if on_chain[index] {
                return Err(Stop::Off(CYCLE));
            }
            on_chain[index] = true;
            chain.push(index);
            at = parents[index];
        }
        chain.reverse();
        // Each message off the chain joins its run's group, keyed by the run's first message: a sidechain run up to the
        // message it hangs from, or a branch up to where it forks from the chain.
        memo.fill(Climb::Unknown);
        let mut branch_memo = memo;
        let mut side_memo = vec![Climb::Unknown; n];
        let mut groups = Vec::with_capacity(messages.len() - chain.len());
        for &index in &messages {
            if on_chain[index] {
                continue;
            }
            let found = if side[index] {
                climb(index, &mut side_memo, &mut path, |at| parents[at], |at| !side[at], steps)?
            } else {
                climb(index, &mut branch_memo, &mut path, |at| parents[at], |at| on_chain[at], steps)?
            };
            let (attach, root) = found.ok_or(Stop::Off(CYCLE))?;
            groups.push((!side[index], root, attach, index));
        }
        // Sidechains first, since a branch nests the ones hanging from its messages; each by its first message, and its
        // members in file order (the sort is stable).
        groups.sort_by_key(|&(branch, root, _, _)| (branch, root));
        let mut side_items: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
        let mut branch_items: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
        for group in groups.chunk_by(|a, b| (a.0, a.1) == (b.0, b.1)) {
            let (branch, _, attach, first) = group[0];
            let mut children = Vec::new();
            for &(_, _, _, entry) in group {
                children.extend(self.turn_items(entry, steps)?);
                if branch && let Some(nested) = side_items.remove(&Some(entry)) {
                    children.extend(nested);
                }
            }
            let (kind, items) = if branch {
                self.census.branches += 1;
                ("branch", &mut branch_items)
            } else {
                self.census.sidechains += 1;
                ("sidechain", &mut side_items)
            };
            let item = self.item(kind, first, None, children);
            items.entry(attach).or_default().push(item);
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
                steps.tick()?;
                let item = self.item("event", events[event_at], None, Vec::new());
                self.main.push(item);
                event_at += 1;
            }
            let turns = self.turn_items(entry, steps)?;
            self.main.extend(turns);
            if let Some(branch) = branch_items.remove(&Some(entry)) {
                self.main.extend(branch);
            }
            if let Some(side) = side_items.remove(&Some(entry)) {
                self.main.extend(side);
            }
        }
        while event_at < events.len() {
            steps.tick()?;
            let item = self.item("event", events[event_at], None, Vec::new());
            self.main.push(item);
            event_at += 1;
        }
        // A branch forks from the chain, and a sidechain hangs from the chain or a branch's message, or from neither.
        debug_assert!(branch_items.is_empty() && side_items.is_empty(), "a group was left out of the main order");
        Ok(())
    }
}
const CYCLE: &str = "Transcript parent graph contains a cycle; inspect in Rows";
/// How `finish` stopped short.
enum Stop {
    /// The graph is off for this reason; Rows remains.
    Off(&'static str),
    Cancelled,
}
/// `finish`'s work, counted: it checks its cancel flag every `CANCEL_EVERY` steps.
struct Steps(u64);
impl Steps {
    fn tick(&mut self) -> Result<(), Stop> {
        if self.0.is_multiple_of(CANCEL_EVERY) && cancelled() {
            return Err(Stop::Cancelled);
        }
        self.0 += 1;
        Ok(())
    }
}
/// A node's place in a climb (`climb`).
#[derive(Clone, Copy)]
enum Climb {
    Unknown,
    Visiting,
    /// Where its run attaches, and the run's first node.
    Done(Option<usize>, usize),
}
/// From `start` up through `up` until a parent satisfies `stop`, or none is left: that parent, where the run attaches,
/// and the run's first node, the last before it. Every node on the way has the same answer, so `memo` keeps it and no
/// node is climbed twice: linear over a graph, where a walk from each node was quadratic (M5 PR 1: a 20,000-message
/// branch took 6.4 s). `None` on a cycle.
fn climb(
    start: usize,
    memo: &mut [Climb],
    path: &mut Vec<usize>,
    up: impl Fn(usize) -> Option<usize>,
    stop: impl Fn(usize) -> bool,
    steps: &mut Steps,
) -> Result<Option<(Option<usize>, usize)>, Stop> {
    path.clear();
    let mut at = start;
    let found = loop {
        steps.tick()?;
        match memo[at] {
            Climb::Done(attach, root) => break (attach, root),
            Climb::Visiting => return Ok(None),
            Climb::Unknown => {}
        }
        memo[at] = Climb::Visiting;
        path.push(at);
        match up(at) {
            Some(parent) if !stop(parent) => at = parent,
            parent => break (parent, at),
        }
    };
    for &node in path.iter() {
        memo[node] = Climb::Done(found.0, found.1);
    }
    Ok(Some(found))
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
    use super::Graph;
    use crate::{
        budget::Reservation,
        doc::{DocError, Document},
        json::{self, Span},
        jsonl::Index,
        store::{cancellable, testutil::temp_file},
    };
    use std::sync::{Arc, atomic::AtomicBool};
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
    /// `finish` is linear: off the chain, each message of a 4,000-message branch is 1 to 4,000 messages from the fork,
    /// about 8 million steps for a walk from each. Memoized climbs take a few steps a record.
    #[test]
    fn finish_is_linear_in_a_long_branch() {
        let record = |uuid: &str, parent: &str| {
            format!(
                r#"{{"type":"user","uuid":"{uuid}","parentUuid":{parent},"message":{{"role":"user","content":"x"}}}}"#
            )
        };
        let mut lines = vec![record("u0", "null"), record("a1", r#""u0""#)];
        lines.extend((2..=4000).map(|i| record(&format!("a{i}"), &format!(r#""a{}""#, i - 1))));
        lines.push(record("b1", r#""u0""#));
        let index = fixture("transcript-long-branch", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        let branch = graph.main.iter().map(|&id| &graph.items[id]).find(|item| item.kind == "branch").unwrap();
        assert_eq!((graph.census.branches, branch.children.len()), (1, 4000));
        let records = graph.entries.len() as u64;
        assert!(graph.steps < 16 * records, "{} steps for {records} records", graph.steps);
    }
    /// A parent cycle off the chain turns the graph off, rather than looping or losing its messages.
    #[test]
    fn a_parent_cycle_turns_the_graph_off() {
        let index = fixture(
            "transcript-cycle",
            &[
                r#"{"type":"user","uuid":"a","parentUuid":"b","message":{"role":"user","content":"a"}}"#,
                r#"{"type":"assistant","uuid":"b","parentUuid":"a","message":{"role":"assistant","content":"b"}}"#,
                r#"{"type":"user","uuid":"z","parentUuid":null,"message":{"role":"user","content":"z"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(!graph.ready);
        assert_eq!(graph.reason.as_deref(), Some(super::CYCLE));
        assert_eq!(graph.charged(), 0);
    }
    /// A cancelled `finish` stops at its next check, leaving the graph off and holding nothing.
    #[test]
    fn a_cancelled_finish_turns_the_graph_off() {
        let lines = [
            r#"{"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
            r#"{"type":"assistant","uuid":"a","parentUuid":"u","message":{"role":"assistant","content":"reply"}}"#,
        ];
        let file = temp_file("transcript-cancelled", lines.join("\n").as_bytes());
        let doc = Document::open(&file).unwrap();
        let mut graph = Graph::new();
        doc.verified(1, |store| {
            let mut at = 0;
            for (line, text) in lines.iter().enumerate() {
                let span = Span { start: at, end: at + text.len() as u64 };
                graph.observe(store, &json::scan(store, span.start..span.end, false)?, line as u64, span)?;
                at = span.end + 1;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(graph.entries.len(), 2);
        assert!(graph.charged() > 0);
        let cancel = Arc::new(AtomicBool::new(true));
        assert!(matches!(cancellable(&cancel, || graph.finish(Some("claude-code-v1"))), Err(DocError::Cancelled)));
        assert!(!graph.ready && graph.entries.is_empty() && graph.items.is_empty());
        assert_eq!(graph.charged(), 0);
    }
}
