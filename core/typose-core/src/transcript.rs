//! Source-backed transcript metadata (brief §5.4). Payloads remain in the verified JSONL source: `observe` keeps each
//! record's spans and container ids as the JSONL index reads it, and `finish` builds the displayed order once the file
//! is indexed. Past a cap, the graph is off and Rows remains.
//!
//! **Memory (spec §3.6, plan C1).** What the graph keeps is reserved at its real size: each vector's slots from its
//! element's `size_of` and its capacity (`json::room` grows the long ones), and each string's capacity (`heap`).
//! `finish` reserves its temporaries before it makes any (`finish_temp`). A refusal turns the graph off and releases
//! all it holds, as closing the document does.
use crate::budget::Reservation;
use crate::doc::{DocError, Document};
use crate::json::{self, Child, JsonIndex, Kind, Span};
use crate::jsonl::{named_fields, read_string, visit_members};
use crate::pages::PIECE_BYTES;
use crate::store::{ByteStore, StoreError, cancelled};
use encoding_rs::Encoding;
use std::collections::{HashMap, HashSet};
use xxhash_rust::xxh3::xxh3_64;

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
    /// `parentUuid`, or with none, `logicalParentUuid` (`logical`): a compaction boundary's.
    pub parent: Option<String>,
    pub logical: bool,
    pub sidechain: bool,
    /// A hash of `message.id`, which a Claude Code message's records share.
    pub message: Option<u64>,
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
        self.census = Census::default();
        // The memory, then what paid for it.
        self.entries = Vec::new();
        self.items = Vec::new();
        self.main = Vec::new();
        self.charge = Reservation::none();
    }
    /// The JSONL index stopped short of the file (its budget, an error, a cancel), so the graph never finishes: what
    /// it holds goes now.
    pub fn stop(&mut self) {
        if self.reason.is_none() {
            self.disable("Transcript graph stopped with the JSONL index; Rows remains available");
        }
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
                "logicalParentUuid",
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
        // The entry's turns, reserved as they're made, until the entry is charged to the graph. Declared first, so it's
        // released after them.
        let mut held = Reservation::none();
        let (parent, logical) = match string("parentUuid")? {
            Some(parent) => (Some(parent), false),
            None => {
                let logical = string("logicalParentUuid")?;
                let is = logical.is_some();
                (logical, is)
            }
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
            parent,
            logical,
            sidechain: fields.get("isSidechain").is_some_and(|node| node.kind == Kind::True),
            message: None,
        };
        if entry.uuid.as_ref().is_some_and(|value| value.len() >= 4094)
            || entry.parent.as_ref().is_some_and(|value| value.len() >= 4094)
        {
            self.disable("A transcript graph ID exceeds its metadata limit; Rows preserves the source");
            return Ok(());
        }
        let mut fits = true;
        let event_type = string("type")?.unwrap_or_default();
        if matches!(event_type.as_str(), "user" | "assistant")
            && let Some(container) =
                fields.get("message").filter(|node| node.kind == Kind::Object).and_then(|node| node.container)
        {
            entry.schema = "claude-code-v1";
            let id = named_fields(store, index, container, &["id"])?;
            entry.message = id
                .get("id")
                .filter(|node| node.kind == Kind::String)
                .map(|node| read_string(store, node.value))
                .transpose()?
                .map(|id| xxh3_64(id.as_bytes()));
            fits = turn(store, index, container, true, &mut held)?
                .is_some_and(|turn| push(&mut entry.turns, &mut held, 0, turn));
        } else if let Some(container) =
            fields.get("messages").filter(|node| node.kind == Kind::Array).and_then(|node| node.container)
        {
            entry.schema = "openai-dataset-v1";
            visit_members(store, index, container, |message| {
                if let Some(container) = message.container.filter(|_| message.kind == Kind::Object) {
                    fits = turn(store, index, container, false, &mut held)?
                        .is_some_and(|turn| push(&mut entry.turns, &mut held, 0, turn));
                }
                Ok(fits)
            })?;
        } else if string("role")?.is_some_and(|role| crate::jsonl::known_role(&role)) && fields.contains_key("content")
        {
            entry.schema = "openai-chat-v1";
            fits =
                turn(store, index, 0, false, &mut held)?.is_some_and(|turn| push(&mut entry.turns, &mut held, 0, turn));
        }
        if entry.turns.iter().any(|turn| turn.results.len() > MAX_RESULTS || turn.calls.len() > MAX_CALLS) {
            self.disable("A turn exceeds the bounded Transcript tool metadata limit; Rows preserves every block");
            return Ok(());
        }
        if !fits
            || self.entries.len() >= MAX_ENTRIES
            || fit(&mut entry.turns, &mut held).is_err()
            || self.charge.grow(heap(&entry)).is_err()
            || json::room(&mut self.entries, &mut self.charge).is_err()
        {
            self.disable("Transcript graph exceeds its memory or record limit; Rows remains available");
            return Ok(());
        }
        drop(held);
        self.entries.push(entry);
        Ok(())
    }
    /// Called for every record past the first 200 of a file with no schema: only the first turns the graph off.
    pub fn reject_undetected(&mut self) {
        if self.reason.is_none() {
            self.disable("No supported transcript schema was detected in the first 200 parsed records");
        }
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
        let turns = || self.entries.iter().flat_map(|entry| &entry.turns);
        let count =
            (turns().count(), turns().map(|turn| turn.calls.len()).sum(), turns().map(|turn| turn.results.len()).sum());
        // Each item is a turn or stands for a record (an event, a conversation, a group rooted at it).
        if (self.entries.len() + count.0) as u64 > MAX_ITEMS {
            return Err(Stop::Off("Transcript graph exceeds its item limit; Rows remains available"));
        }
        let _temp = Reservation::new(finish_temp(self.entries.len(), count.0, count.1, count.2)).map_err(|_| MEMORY)?;
        if schema == "claude-code-v1" {
            self.drop_copies(steps)?;
        }
        self.match_tools(schema, steps)?;
        if schema == "claude-code-v1" {
            self.claude(steps)?;
        } else {
            self.openai(schema, steps)?;
        }
        // What the vectors grew past their length goes back.
        fit(&mut self.entries, &mut self.charge).map_err(|_| MEMORY)?;
        fit(&mut self.items, &mut self.charge).map_err(|_| MEMORY)?;
        fit(&mut self.main, &mut self.charge).map_err(|_| MEMORY)
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
            freed += if keep[at - 1] { 0 } else { heap(entry) };
            keep[at - 1]
        });
        self.charge.shrink(freed);
        Ok(())
    }
    fn item(
        &mut self,
        kind: &'static str,
        entry: usize,
        turn: Option<usize>,
        mut children: Vec<usize>,
    ) -> Result<usize, Stop> {
        json::room(&mut self.items, &mut self.charge).map_err(|_| MEMORY)?;
        // `children` grew within `finish_temp`'s reservation; the graph pays for its length.
        self.charge.grow((children.len() * size_of::<usize>()) as u64).map_err(|_| MEMORY)?;
        children.shrink_to_fit();
        let id = self.items.len();
        self.items.push(Item { kind, entry, turn, children });
        Ok(id)
    }
    /// Puts `items` next in the main order.
    fn show(&mut self, items: impl IntoIterator<Item = usize>) -> Result<(), Stop> {
        for item in items {
            json::room(&mut self.main, &mut self.charge).map_err(|_| MEMORY)?;
            self.main.push(item);
        }
        Ok(())
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
            items.push(self.item("turn", entry, Some(index), Vec::new())?);
        }
        Ok(items)
    }
    fn match_tools(&mut self, schema: &str, steps: &mut Steps) -> Result<(), Stop> {
        let turns = || self.entries.iter().flat_map(|entry| &entry.turns);
        let mut calls = HashMap::with_capacity(turns().map(|turn| turn.calls.len()).sum());
        let mut links: Vec<(Place, Place)> = Vec::with_capacity(turns().map(|turn| turn.results.len()).sum());
        // In file order, each result links to the latest call before it with its id: a legacy `function_call`'s id is
        // its name, which later calls reuse, and a chat may reuse a `tool_call_id`.
        for (entry_index, entry) in self.entries.iter().enumerate() {
            steps.tick()?;
            if !same_schema(entry.schema, schema) {
                continue;
            }
            for (turn_index, turn) in entry.turns.iter().enumerate() {
                steps.tick()?;
                self.census.messages += 1;
                let prefix = if entry.schema == "openai-dataset-v1" { entry_index + 1 } else { 0 };
                for (result_index, result) in turn.results.iter().enumerate() {
                    steps.tick()?;
                    match calls.get(&(prefix, result.id.as_str())) {
                        Some(&call) => links.push((call, (entry_index, turn_index, result_index))),
                        None => self.census.unmatched_results += 1,
                    }
                }
                for (call_index, call) in turn.calls.iter().enumerate() {
                    steps.tick()?;
                    if !call.id.is_empty() {
                        calls.insert((prefix, call.id.as_str()), (entry_index, turn_index, call_index));
                    }
                    self.census.calls += 1;
                }
            }
        }
        drop(calls);
        // Each call's results in file order, in a vector of exactly their number.
        links.sort_unstable();
        for group in links.chunk_by(|a, b| a.0 == b.0) {
            let (entry, turn, call) = group[0].0;
            self.charge.grow((group.len() * size_of::<ResultLink>()) as u64).map_err(|_| MEMORY)?;
            let call = &mut self.entries[entry].turns[turn].calls[call];
            call.results = group.iter().map(|&(_, (entry, turn, result))| ResultLink { entry, turn, result }).collect();
            for &(_, (entry, turn, result)) in group {
                steps.tick()?;
                self.entries[entry].turns[turn].results[result].linked = true;
            }
            self.census.matched_results += group.len() as u64;
        }
        Ok(())
    }
    fn openai(&mut self, schema: &str, steps: &mut Steps) -> Result<(), Stop> {
        for entry in 0..self.entries.len() {
            steps.tick()?;
            if same_schema(self.entries[entry].schema, schema) {
                let turns = self.turn_items(entry, steps)?;
                if self.entries[entry].schema == "openai-dataset-v1" {
                    let item = self.item("conversation", entry, None, turns)?;
                    self.show([item])?;
                } else {
                    self.show(turns)?;
                }
            } else {
                self.census.events += 1;
                let item = self.item("event", entry, None, Vec::new())?;
                self.show([item])?;
            }
        }
        Ok(())
    }
    fn claude(&mut self, steps: &mut Steps) -> Result<(), Stop> {
        let n = self.entries.len();
        let message: Vec<bool> = self.entries.iter().map(|entry| entry.schema == "claude-code-v1").collect();
        let count = message.iter().filter(|&&is| is).count();
        let (mut messages, mut events) = (Vec::with_capacity(count), Vec::with_capacity(n - count));
        for (index, &is) in message.iter().enumerate() {
            (if is { &mut messages } else { &mut events }).push(index);
        }
        self.census.events = events.len() as u64;
        let mut ids = HashMap::with_capacity(n);
        for (index, entry) in self.entries.iter().enumerate() {
            steps.tick()?;
            if let Some(uuid) = &entry.uuid {
                ids.insert(uuid.as_str(), index); // unique: `drop_copies` ran
            }
        }
        // Compaction leaves a `compact_boundary` record with no parent; its logical parent joins the session before it
        // to the session after. On this PC (M5 PR 1, 27 sessions over 10 MiB), the graph keeps 85 boundaries
        // (`drop_copies` drops 9 later copies), which cut 52,151 of 79,735 messages off the main chain. Only an earlier
        // record is a logical parent: 81 of the 85 name one, and 4, each its file's first, name a later one, which
        // would close a cycle.
        let mut direct = Vec::with_capacity(n);
        for (index, entry) in self.entries.iter().enumerate() {
            steps.tick()?;
            let parent = entry.parent.as_deref().and_then(|id| ids.get(id).copied());
            direct.push(parent.filter(|&at| !entry.logical || at < index));
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
        memo.fill(Climb::Unknown);
        self.lanes(&messages, &side, &mut parents, steps)?;
        self.parallel_calls(&messages, &side, &mut parents, &mut memo, &mut path, steps)?;
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
        let mut chain = Vec::with_capacity(messages.len());
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
        let mut side_items: HashMap<Option<usize>, Vec<usize>> = HashMap::with_capacity(groups.len());
        let mut branch_items: HashMap<Option<usize>, Vec<usize>> = HashMap::with_capacity(groups.len());
        for group in groups.chunk_by(|a, b| (a.0, a.1) == (b.0, b.1)) {
            let (branch, _, attach, first) = group[0];
            let mut children = Vec::new();
            for &(_, _, _, entry) in group {
                children.extend(self.turn_items(entry, steps)?);
                if branch && let Some(nested) = side_items.remove(&Some(entry)) {
                    children.extend(nested);
                }
            }
            // A group of tool results only, each shown under its call, shows nothing: it isn't one.
            if children.is_empty() {
                continue;
            }
            let (kind, items) = if branch {
                self.census.branches += 1;
                ("branch", &mut branch_items)
            } else {
                self.census.sidechains += 1;
                ("sidechain", &mut side_items)
            };
            let item = self.item(kind, first, None, children)?;
            items.entry(attach).or_default().push(item);
        }
        self.show(branch_items.remove(&None).into_iter().flatten())?;
        self.show(side_items.remove(&None).into_iter().flatten())?;
        let mut event_at = 0;
        for entry in chain {
            while event_at < events.len() && events[event_at] < entry {
                steps.tick()?;
                let item = self.item("event", events[event_at], None, Vec::new())?;
                self.show([item])?;
                event_at += 1;
            }
            let turns = self.turn_items(entry, steps)?;
            self.show(turns)?;
            self.show(branch_items.remove(&Some(entry)).into_iter().flatten())?;
            self.show(side_items.remove(&Some(entry)).into_iter().flatten())?;
        }
        while event_at < events.len() {
            steps.tick()?;
            let item = self.item("event", events[event_at], None, Vec::new())?;
            self.show([item])?;
            event_at += 1;
        }
        // A branch forks from the chain, and a sidechain hangs from the chain or a branch's message, or from neither.
        debug_assert!(branch_items.is_empty() && side_items.is_empty(), "a group was left out of the main order");
        Ok(())
    }
    /// Interleaved lanes. Claude Code runs a message's calls while the message still streams, and hangs the message's
    /// next record from the result it wrote last, so the message's records split into two lanes through the file. On
    /// this PC (M5 PR 1, 27 sessions over 10 MiB), that left 58 false branches in 11 files, hiding 96 calls of messages
    /// on the chain. Here a record of message M whose parent is a record of only results, all to M's calls, hangs
    /// instead from M's previous record in the file. That makes M one run again, before `parallel_calls` closes its
    /// results' forks (it moves 3,446 records in those 27 files). The new parent is always earlier in the file, but a
    /// parent written later can still close a cycle; the climbs after this turn the graph off.
    fn lanes(
        &self,
        messages: &[usize],
        side: &[bool],
        parents: &mut [Option<usize>],
        steps: &mut Steps,
    ) -> Result<(), Stop> {
        let entries = &self.entries;
        // Each record's results, by the message whose calls they answer (none if more than one, or one with no
        // `message.id`) and how many link (`match_tools` links each once).
        let mut answers = vec![(None, 0u32); entries.len()];
        for entry in entries {
            steps.tick()?;
            for link in entry.turns.iter().flat_map(|turn| &turn.calls).flat_map(|call| &call.results) {
                steps.tick()?;
                let (message, count) = &mut answers[link.entry];
                if *count == 0 {
                    *message = entry.message;
                } else if *message != entry.message {
                    *message = None;
                }
                *count += 1;
            }
        }
        // Each message's last record so far, in file order.
        let mut last = HashMap::with_capacity(messages.len());
        for &index in messages {
            steps.tick()?;
            let Some(message) = entries[index].message.filter(|_| !side[index]) else {
                continue;
            };
            if let (Some(previous), Some(parent)) = (last.insert(message, index), parents[index])
                && parent != previous
                && entries[parent].turns.first().is_some_and(|turn| {
                    turn.only_results
                        && !turn.results.is_empty()
                        && answers[parent] == (Some(message), turn.results.len() as u32)
                })
            {
                parents[index] = Some(previous);
            }
        }
        Ok(())
    }
    /// Parallel tool calls. Claude Code writes an assistant message's blocks as records of one `message.id`, each the
    /// parent of the next, and each tool result as a child of the record holding its call: a message's calls fork
    /// each of its records but the last, into the next one and that record's result. On this PC (M5 PR 1, 27 sessions
    /// over 10 MiB), the graph after compaction's logical parents has 2,790 forks, and 2,742 have exactly that shape:
    /// an assistant parent with two children, a record of its `message.id` first in the file, then a record of only
    /// results to the parent's calls. After `lanes`, 2,937 do. There the result hangs from the message's last record
    /// instead, and the fork closes. Every other fork stays a branch.
    fn parallel_calls(
        &self,
        messages: &[usize],
        side: &[bool],
        parents: &mut [Option<usize>],
        memo: &mut [Climb],
        path: &mut Vec<usize>,
        steps: &mut Steps,
    ) -> Result<(), Stop> {
        let entries = &self.entries;
        // Each message's first two children in the file and how many it has, up to 3; and its first child of its
        // `message.id`, the message's next record.
        let mut children = vec![(0u8, 0, 0); entries.len()];
        let mut next = vec![None; entries.len()];
        for &index in messages {
            steps.tick()?;
            let Some(parent) = parents[index].filter(|_| !side[index]) else {
                continue;
            };
            let (count, first, second) = &mut children[parent];
            match *count {
                0 => *first = index,
                1 => *second = index,
                _ => {}
            }
            *count = (*count + 1).min(3);
            if next[parent].is_none() && entries[index].message.is_some_and(|id| entries[parent].message == Some(id)) {
                next[parent] = Some(index);
            }
        }
        for &parent in messages {
            steps.tick()?;
            let (count, call, result) = children[parent];
            if count == 2 && self.parallel_fork(parent, call, result, steps)? {
                let (_, last) = climb(call, memo, path, |at| next[at], |_| false, steps)?.ok_or(Stop::Off(CYCLE))?;
                parents[result] = Some(last);
            }
        }
        Ok(())
    }
    /// Whether `parent`'s children `call` and `result`, in file order, are its message's next record and a record of
    /// only results to its own calls.
    fn parallel_fork(&self, parent: usize, call: usize, result: usize, steps: &mut Steps) -> Result<bool, Stop> {
        let entries = &self.entries;
        let assistant = |at: usize| entries[at].turns.first().filter(|turn| turn.role == "assistant");
        let (Some(calls), Some(_)) = (assistant(parent), assistant(call)) else {
            return Ok(false);
        };
        let Some(results) = entries[result].turns.first().filter(|turn| turn.only_results) else {
            return Ok(false);
        };
        if entries[call].message.is_none_or(|id| entries[parent].message != Some(id)) {
            return Ok(false);
        }
        // `match_tools` links each result once, so its results are all the parent's when as many link to its calls.
        let mut answered = 0;
        for link in calls.calls.iter().flat_map(|call| &call.results) {
            steps.tick()?;
            answered += usize::from(link.entry == result);
        }
        Ok(!results.results.is_empty() && answered == results.results.len())
    }
}
const CYCLE: &str = "Transcript parent graph contains a cycle; inspect in Rows";
const MEMORY: Stop = Stop::Off("Transcript graph exceeds its memory budget; Rows remains available");
/// A turn, or a call or result in it: its entry, turn and ordinal.
type Place = (usize, usize, usize);
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
/// branch took 6.4-6.8 s). `None` on a cycle.
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
/// What a turn holds on the heap: its role, and its calls' and results' slots and strings.
fn turn_heap(turn: &Turn) -> u64 {
    let calls: usize = turn
        .calls
        .iter()
        .map(|call| call.id.capacity() + call.name.capacity() + call.results.capacity() * size_of::<ResultLink>())
        .sum();
    let results: usize = turn.results.iter().map(|result| result.id.capacity()).sum();
    (turn.role.capacity()
        + turn.calls.capacity() * size_of::<ToolCall>()
        + calls
        + turn.results.capacity() * size_of::<ToolResult>()
        + results) as u64
}
/// What an entry holds on the heap, its slot in `Graph::entries` aside: its strings, and its turns' slots and heap.
fn heap(entry: &Entry) -> u64 {
    let strings = entry.timestamp.capacity()
        + entry.uuid.as_ref().map_or(0, String::capacity)
        + entry.parent.as_ref().map_or(0, String::capacity);
    (strings + entry.turns.capacity() * size_of::<Turn>()) as u64 + entry.turns.iter().map(turn_heap).sum::<u64>()
}
/// Adds `value` to `values`, reserving its `strings`' bytes and its slot (`json::room`) in `held` first. False if the
/// ledger refuses.
fn push<T>(values: &mut Vec<T>, held: &mut Reservation, strings: usize, value: T) -> bool {
    if held.grow(strings as u64).is_err() || json::room(values, held).is_err() {
        return false;
    }
    values.push(value);
    true
}
/// Shrinks `values`, whose capacity `charge` pays for, to its length, and releases the rest. The smaller block is
/// reserved first, since a moving realloc holds both.
fn fit<T>(values: &mut Vec<T>, charge: &mut Reservation) -> Result<(), crate::budget::OverBudget> {
    let old = values.capacity();
    if old > values.len() {
        charge.grow((values.len() * size_of::<T>()) as u64)?;
        values.shrink_to_fit();
        charge.shrink((old * size_of::<T>()) as u64);
    }
    Ok(())
}
/// The most a `HashMap` or `HashSet` of `T`s made `with_capacity(n)` allocates: hashbrown's buckets, n × 8/7 to a
/// power of two, each a `T` and a control byte, then a group of control bytes and its alignment.
fn table<T>(n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    let buckets = if n < 8 { 8 } else { (n * 8 / 7).next_power_of_two() };
    buckets * (size_of::<T>() + 1) + 32
}
/// `finish`'s temporaries for `records` records of `turns` turns, `calls` tool calls and `results` tool results,
/// reserved before it makes any. Each table is one `with_capacity` (`table`) and each list one `Vec::with_capacity` of
/// at most a record, call or result each; the lists of items it collects grow, so they count four slots an item, a
/// growing `Vec`'s most. Its phases run one after another, and this is their sum.
fn finish_temp(records: usize, turns: usize, calls: usize, results: usize) -> u64 {
    type Group = (bool, usize, Option<usize>, usize);
    let copies = table::<&str>(records) + records;
    let tools = table::<((usize, &str), Place)>(calls) + results * size_of::<(Place, Place)>();
    // A record's four flags, three indexes (messages or events, the climb's path, the chain), three parents (direct,
    // nearest message, and its message's next record), the message its results answer (`lanes`), its first two
    // children, two memos, and its group with the stable sort's scratch for it; then the uuid table, `lanes`' table of
    // each message's last record, the two group tables and their lists.
    let claude = records
        * (4 + 3 * size_of::<usize>()
            + 3 * size_of::<Option<usize>>()
            + size_of::<(Option<u64>, u32)>()
            + size_of::<(u8, usize, usize)>()
            + 2 * size_of::<Climb>()
            + 2 * size_of::<Group>()
            + 4 * size_of::<usize>())
        + table::<(&str, usize)>(records)
        + table::<(u64, usize)>(records)
        + 2 * table::<(Option<usize>, Vec<usize>)>(records);
    // `turn_items`' lists and the groups' children: an item each, both growing.
    let lists = 2 * 4 * size_of::<usize>() * (records + turns);
    (copies + tools + claude + lists) as u64
}
fn same_schema(entry: &str, schema: &str) -> bool {
    entry == schema || entry.starts_with("openai-") && schema.starts_with("openai-")
}
/// A message's turn. Each call and result is reserved in `held`, its slot and strings, before it's added (`push`):
/// lossy decoding makes each invalid byte of an id or name three, so a turn's 1,024 calls can hold 25 MB of strings.
/// `None` if the ledger refuses.
fn turn(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    claude: bool,
    held: &mut Reservation,
) -> Result<Option<Turn>, StoreError> {
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
    if held.grow(role.capacity() as u64).is_err() {
        return Ok(None);
    }
    let content = fields.get("content").map(|node| reference(index, node));
    let mut turn = Turn { role, content, container, calls: Vec::new(), results: Vec::new(), only_results: false };
    let mut fits = true;
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
                        Some("tool_use") => {
                            let call = ToolCall {
                                id: string("id")?.unwrap_or_default(),
                                name: string("name")?.unwrap_or_else(|| "Tool".into()),
                                block: reference(index, &block),
                                input: fields.get("input").map(|node| reference(index, node)),
                                results: Vec::new(),
                            };
                            fits = push(&mut turn.calls, held, call.id.capacity() + call.name.capacity(), call);
                        }
                        Some("tool_result") => {
                            let result = ToolResult {
                                id: string("tool_use_id")?.unwrap_or_default(),
                                block: reference(index, &block),
                                content: fields.get("content").map(|node| reference(index, node)),
                                linked: false,
                            };
                            fits = push(&mut turn.results, held, result.id.capacity(), result);
                        }
                        _ => {}
                    }
                }
                Ok(fits && turn.calls.len() <= MAX_CALLS && turn.results.len() <= MAX_RESULTS)
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
                        let tool = ToolCall {
                            id,
                            name,
                            block: reference(index, &call),
                            input: fields.get("arguments").map(|node| reference(index, node)),
                            results: Vec::new(),
                        };
                        fits = push(&mut turn.calls, held, tool.id.capacity() + tool.name.capacity(), tool);
                    }
                }
                Ok(fits && turn.calls.len() <= MAX_CALLS)
            })?;
        }
        if fits && matches!(turn.role.as_str(), "tool" | "function") {
            let id = string("tool_call_id")?
                .or_else(|| string("name").ok().flatten().map(|name| legacy_id(&name)))
                .unwrap_or_default();
            if let Some(content) = &turn.content {
                let result = ToolResult { id, block: content.clone(), content: Some(content.clone()), linked: false };
                fits = push(&mut turn.results, held, result.id.capacity(), result);
                turn.only_results = true;
            }
        }
        if fits && let Some(function) = fields.get("function_call").and_then(|node| node.container) {
            let fields = named_fields(store, index, function, &["name", "arguments"])?;
            let name = fields
                .get("name")
                .map(|node| read_string(store, node.value))
                .transpose()?
                .unwrap_or_else(|| "Tool".into());
            let block = fields.get("arguments").map(|node| reference(index, node));
            if let Some(block) = block {
                let call = ToolCall {
                    id: legacy_id(&name),
                    name,
                    block: block.clone(),
                    input: Some(block),
                    results: Vec::new(),
                };
                fits = push(&mut turn.calls, held, call.id.capacity() + call.name.capacity(), call);
            }
        }
    }
    if !fits || fit(&mut turn.calls, held).is_err() || fit(&mut turn.results, held).is_err() {
        return Ok(None);
    }
    Ok(Some(turn))
}
/// A legacy `function_call`'s id, which its result shares: `function:` and its function's name, cut to the core host's
/// bound on a tool id, 4,096 UTF-16 units (structured-validation.ts).
fn legacy_id(name: &str) -> String {
    let mut units = "function:".len();
    let name = name.chars().take_while(|c| {
        units += c.len_utf16();
        units <= 4096
    });
    "function:".chars().chain(name).collect()
}

/// An OpenAI tool call's `arguments` (brief §5.4): the JSON a JSON string holds, decoded and indexed in memory for one
/// query, so its Tree reads as a Claude call's input does, a number as written. What it holds is reserved, its bytes
/// here and its index by the scan, and released with it.
pub struct Arguments {
    pub root: Child,
    pub index: JsonIndex,
    pub bytes: Vec<u8>,
    _charge: Reservation,
}
impl Arguments {
    /// The value the JSON string at `span` holds. `None`, so the string shows as it is, past `PIECE_BYTES` of source
    /// (the text query's bound) or of value, for a span that isn't one string, or for a value that isn't strict JSON.
    /// The ledger's refusal, of its reservation or of either scan's, is `DocError::Memory`.
    pub fn read(
        doc: &Document,
        generation: u32,
        span: Span,
        encoding: &'static Encoding,
    ) -> Result<Option<Self>, DocError> {
        let length = span.end.saturating_sub(span.start);
        if length > PIECE_BYTES as u64 {
            return Ok(None);
        }
        // The source; its text, at most 3 bytes a byte of it; and the value, at most the text.
        let charge = Reservation::new(7 * length).map_err(DocError::Memory)?;
        let source = doc.read(generation, span.start, span.end)?;
        let text = encoding.decode_without_bom_handling(&source).0;
        let token = json::parse(text.as_bytes()).map_err(in_memory)?;
        if stopped(&token)? || token.root != Some((Kind::String, Span { start: 0, end: text.len() as u64 })) {
            return Ok(None);
        }
        let bytes = json::unescape(text.as_bytes()).into_owned();
        if bytes.len() > PIECE_BYTES {
            return Ok(None);
        }
        let index = json::parse(&bytes).map_err(in_memory)?;
        if stopped(&index)? {
            return Ok(None);
        }
        let Some((kind, value)) = index.root else {
            return Ok(None); // empty, or only whitespace
        };
        let container = matches!(kind, Kind::Object | Kind::Array).then_some(0);
        Ok(Some(Self {
            root: Child { key: None, value, kind, container, text: Vec::new() },
            index,
            bytes,
            _charge: charge,
        }))
    }
    /// A page of `container`'s children, each with whether its key repeats an earlier one's (brief §5.5).
    pub fn children(&self, container: u32, start: u64, count: usize) -> Result<Vec<(u64, Child, bool)>, DocError> {
        let children = json::children(&self.bytes[..], &self.index, container, start, count).map_err(in_memory)?;
        let members =
            self.index.containers.get(container as usize).filter(|c| c.kind == Kind::Object).map_or(0, |c| c.children);
        // `duplicate_keys`' set of key hashes, reserved as a record-scoped Tree reserves it: 80 bytes a member.
        let _keys = Reservation::new(members * 80).map_err(DocError::Memory)?;
        let found = match members {
            0 | 1 => Vec::new(),
            _ => json::duplicate_keys(&self.bytes[..], &self.index, container)
                .map_err(in_memory)?
                .ok_or(DocError::Cancelled)?,
        };
        Ok(children.into_iter().zip(start..).map(|(child, at)| (at, child, found.binary_search(&at).is_ok())).collect())
    }
    /// A key, decoded from its first 4,096 bytes, as `jsonl::read_string_encoding` reads one.
    pub fn key(&self, key: Span) -> String {
        let token = self.bytes.get(key.start as usize..key.end.min(key.start + 4096) as usize).unwrap_or_default();
        String::from_utf8_lossy(&json::unescape(token)).into_owned()
    }
    /// A scalar's first 4,096 bytes as text, as written, and whether that cut it short.
    pub fn text(&self, value: Span) -> (String, bool) {
        let bytes = self.bytes.get(value.start as usize..value.end as usize).unwrap_or_default();
        let shown = &bytes[..bytes.len().min(4096)];
        let (slice, used) = crate::encoding::decode_prefix(
            shown,
            encoding_rs::UTF_8,
            value.start,
            shown.len(),
            shown.len() == bytes.len(),
        );
        (slice.text, used < bytes.len())
    }
}
/// Whether a scan stopped at a syntax or depth error. A memory refusal or a cancel is an error, at either of
/// `Arguments::read`'s scans, as its reservation's refusal is.
fn stopped(index: &JsonIndex) -> Result<bool, DocError> {
    match index.error.map(|error| error.kind) {
        Some(json::ErrorKind::Memory(e)) => Err(DocError::Memory(e)),
        Some(json::ErrorKind::Cancelled) => Err(DocError::Cancelled),
        error => Ok(error.is_some()),
    }
}
/// Reads from memory don't fail, but a `StoreError` here would be reported, never a panic.
fn in_memory(e: StoreError) -> DocError {
    DocError::Invalid(format!("in-memory JSON read failed: {e}"))
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
        assert_eq!(graph.census.messages, 0, "the census goes with the graph");
    }
    /// The main order: each item's kind and its record's uuid.
    fn order(graph: &Graph) -> Vec<(&'static str, &str)> {
        graph
            .main
            .iter()
            .map(|&id| (graph.items[id].kind, graph.entries[graph.items[id].entry].uuid.as_deref().unwrap_or("")))
            .collect()
    }
    /// Compaction: a `compact_boundary` record has no parent, but names the message the session went on from. The
    /// session after it is the same chain, with the boundary an event in its place.
    #[test]
    fn a_compaction_boundary_joins_its_two_segments() {
        let index = fixture(
            "transcript-compaction",
            &[
                r#"{"type":"user","uuid":"u0","parentUuid":null,"message":{"role":"user","content":"start"}}"#,
                r#"{"type":"assistant","uuid":"a1","parentUuid":"u0","message":{"role":"assistant","content":"reply"}}"#,
                r#"{"type":"system","subtype":"compact_boundary","uuid":"b","parentUuid":null,"logicalParentUuid":"a1"}"#,
                r#"{"type":"user","uuid":"u2","parentUuid":"b","message":{"role":"user","content":"summary"}}"#,
                r#"{"type":"assistant","uuid":"a3","parentUuid":"u2","message":{"role":"assistant","content":"next"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        assert_eq!(graph.census.branches, 0);
        assert_eq!(order(&graph), [("turn", "u0"), ("turn", "a1"), ("event", "b"), ("turn", "u2"), ("turn", "a3")]);
    }
    /// A boundary whose logical parent is written after it would close a cycle (4 sessions on this PC): it stays a
    /// root.
    #[test]
    fn a_boundary_naming_a_later_record_stays_a_root() {
        let index = fixture(
            "transcript-compaction-later",
            &[
                r#"{"type":"system","subtype":"compact_boundary","uuid":"b","parentUuid":null,"logicalParentUuid":"a2"}"#,
                r#"{"type":"user","uuid":"u1","parentUuid":"b","message":{"role":"user","content":"summary"}}"#,
                r#"{"type":"assistant","uuid":"a2","parentUuid":"u1","message":{"role":"assistant","content":"reply"}}"#,
                r#"{"type":"user","uuid":"u3","parentUuid":"a2","message":{"role":"user","content":"next"}}"#,
            ],
        );
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        assert_eq!(order(&graph), [("event", "b"), ("turn", "u1"), ("turn", "a2"), ("turn", "u3")]);
    }
    fn call(uuid: &str, parent: &str, id: &str, message: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","parentUuid":"{parent}","message":{{"id":"{message}","role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"read","input":{{}}}}]}}}}"#
        )
    }
    fn result(uuid: &str, parent: &str, id: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","parentUuid":"{parent}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","content":"r"}}]}}}}"#
        )
    }
    const START: &str = r#"{"type":"user","uuid":"u0","parentUuid":null,"message":{"role":"user","content":"start"}}"#;
    fn reply(parent: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"n","parentUuid":"{parent}","message":{{"id":"N","role":"assistant","content":"done"}}}}"#
        )
    }
    /// Parallel tool calls: Claude Code writes an assistant message's blocks as records of one `message.id`, each the
    /// parent of the next, and each tool result as a child of its call's record. The forks that makes close: whichever
    /// result the session goes on from, the main order is one chain, and each result nests under its call.
    #[test]
    fn parallel_tool_calls_are_one_chain() {
        let two =
            [call("p", "u0", "t1", "M"), call("a", "p", "t2", "M"), result("r1", "p", "t1"), result("r2", "a", "t2")];
        let three = [
            call("p", "u0", "t1", "M"),
            call("a1", "p", "t2", "M"),
            call("a2", "a1", "t3", "M"),
            result("r1", "p", "t1"),
            result("r2", "a1", "t2"),
            result("r3", "a2", "t3"),
        ];
        for (name, records, from, shown) in [
            ("transcript-two-calls-last", &two[..], "r2", &["u0", "p", "a", "n"][..]),
            ("transcript-two-calls-first", &two[..], "r1", &["u0", "p", "a", "n"][..]),
            ("transcript-three-calls-last", &three[..], "r3", &["u0", "p", "a1", "a2", "n"][..]),
            ("transcript-three-calls-first", &three[..], "r1", &["u0", "p", "a1", "a2", "n"][..]),
        ] {
            let mut lines = vec![START.to_string()];
            lines.extend(records.iter().cloned());
            lines.push(reply(from));
            let index = fixture(name, &lines.iter().map(String::as_str).collect::<Vec<_>>());
            let graph = index.transcript.lock().unwrap();
            assert!(graph.ready, "{name}: {:?}", graph.reason);
            assert_eq!((graph.census.branches, graph.census.matched_results), (0, records.len() as u64 / 2), "{name}");
            let turns: Vec<_> = shown.iter().map(|&uuid| ("turn", uuid)).collect();
            assert_eq!(order(&graph), turns, "{name}");
            for entry in graph.entries.iter().filter(|entry| entry.uuid.as_deref() != Some("n")) {
                for call in entry.turns.iter().flat_map(|turn| &turn.calls) {
                    assert_eq!(call.results.len(), 1, "{name}: {:?}", entry.uuid);
                }
            }
        }
    }
    /// A fork of two messages stays a branch: the assistant child has another `message.id`.
    #[test]
    fn a_fork_of_two_messages_stays_a_branch() {
        let lines = [
            START.to_string(),
            call("p", "u0", "t1", "M"),
            call("a", "p", "t2", "OTHER"),
            result("r2", "a", "t2"),
            result("r1", "p", "t1"),
            reply("r1"),
        ];
        let index = fixture("transcript-real-fork", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        assert_eq!(graph.census.branches, 1);
        assert_eq!(order(&graph), [("turn", "u0"), ("turn", "p"), ("branch", "a"), ("turn", "n")]);
    }
    /// Each result links to the latest call before it with its id: a legacy `function_call`'s id is its name, which
    /// later calls reuse, and a chat may reuse a `tool_call_id`. A result before any call with its id stays unmatched.
    #[test]
    fn results_link_to_the_latest_earlier_call() {
        let legacy = [
            r#"{"role":"user","content":"q"}"#,
            r#"{"role":"assistant","content":null,"function_call":{"name":"lookup","arguments":"{\"n\":1}"}}"#,
            r#"{"role":"function","name":"lookup","content":"r1"}"#,
            r#"{"role":"assistant","content":null,"function_call":{"name":"lookup","arguments":"{\"n\":2}"}}"#,
            r#"{"role":"function","name":"lookup","content":"r2"}"#,
        ];
        let reused = [
            r#"{"role":"tool","tool_call_id":"call_1","content":"early"}"#,
            r#"{"role":"user","content":"q"}"#,
            r#"{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}"#,
            r#"{"role":"tool","tool_call_id":"call_1","content":"r1"}"#,
            r#"{"role":"user","content":"q2"}"#,
            r#"{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}"#,
            r#"{"role":"tool","tool_call_id":"call_1","content":"r2"}"#,
        ];
        for (name, lines, links, unmatched) in [
            ("transcript-legacy-calls", &legacy[..], [(1, 2), (3, 4)], 0),
            ("transcript-reused-ids", &reused[..], [(2, 3), (5, 6)], 1),
        ] {
            let index = fixture(name, lines);
            let graph = index.transcript.lock().unwrap();
            assert!(graph.ready, "{name}: {:?}", graph.reason);
            assert_eq!((graph.census.matched_results, graph.census.unmatched_results), (2, unmatched), "{name}");
            let entries = &graph.entries;
            let found: Vec<_> = entries
                .iter()
                .flat_map(|entry| entry.turns.iter().flat_map(|turn| &turn.calls).map(move |call| (entry.line, call)))
                .flat_map(|(line, call)| call.results.iter().map(move |link| (line, entries[link.entry].line)))
                .collect();
            assert_eq!(found, links, "{name}");
        }
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
    fn said(uuid: &str, parent: &str, message: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","parentUuid":"{parent}","message":{{"id":"{message}","role":"assistant","content":[{{"type":"text","text":"x"}}]}}}}"#
        )
    }
    /// Interleaved lanes (`lanes`): each record of message M0 after the first two hangs from a result, in two lanes
    /// through the file. They read as one chain, each result under its call. This is round 2's review fixture `p1-lanes`.
    #[test]
    fn interleaved_lanes_are_one_chain() {
        let lines = [
            START.to_string(),
            call("p", "u0", "tp", "M0"),
            call("a0", "p", "t0", "M0"),
            result("rp", "p", "tp"),
            call("a2", "rp", "t2", "M0"),
            result("r0", "a0", "t0"),
            call("a4", "r0", "t4", "M0"),
            result("r2", "a2", "t2"),
            call("a6", "r2", "t6", "M0"),
            result("r4", "a4", "t4"),
            call("a8", "r4", "t8", "M0"),
            result("r6", "a6", "t6"),
            result("r8", "a8", "t8"),
            said("n", "r8", "M1"),
        ];
        let index = fixture("transcript-lanes", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let graph = index.transcript.lock().unwrap();
        assert!(graph.ready, "{:?}", graph.reason);
        assert_eq!((graph.census.branches, graph.census.matched_results), (0, 6));
        let turns: Vec<_> = ["u0", "p", "a0", "a2", "a4", "a6", "a8", "n"].map(|uuid| ("turn", uuid)).into();
        assert_eq!(order(&graph), turns);
        assert!(
            graph
                .entries
                .iter()
                .flat_map(|entry| &entry.turns)
                .flat_map(|turn| &turn.calls)
                .all(|call| call.results.len() == 1)
        );
    }
    /// A session in one of the shapes `probe2b.cjs` found lanes in (M5 PR 1, round 3), and the records to show. The
    /// spec lists records in file order: `c` a call of message M0, `d` one of M1, `t` text of M1, `r` a record of one
    /// tool result, each with its parent's rank, or `x` for M0's earlier records `P0`, `P1`, …, written first, each the
    /// parent of the next. A result answers its parent's call, or with `x` the next earlier record's; other records with
    /// `x` hang from the last of them. `n` names the record the session goes on from.
    fn shape(spec: &str) -> (Vec<String>, Vec<String>) {
        let tokens: Vec<_> = spec.split(' ').collect();
        let earlier = tokens.iter().filter(|token| token.starts_with('r') && token.ends_with(":x")).count();
        let mut lines = vec![START.to_string()];
        let mut shown = vec!["u0".to_string()];
        for j in 0..earlier {
            let parent = if j == 0 { "u0".to_string() } else { format!("P{}", j - 1) };
            lines.push(call(&format!("P{j}"), &parent, &format!("tP{j}"), "M0"));
            shown.push(format!("P{j}"));
        }
        let mut answered = 0;
        for token in tokens {
            let (kind, rest) = token.split_at(1);
            if kind == "n" {
                lines.push(reply(&format!("r{rest}")));
                shown.push("n".into());
                continue;
            }
            let (rank, parent) = rest.split_once(':').unwrap();
            let uuid = format!("r{rank}");
            let under = if parent == "x" { format!("P{}", earlier - 1) } else { format!("r{parent}") };
            lines.push(match kind {
                "c" | "d" => call(&uuid, &under, &format!("t{rank}"), if kind == "c" { "M0" } else { "M1" }),
                "t" => said(&uuid, &under, "M1"),
                _ if parent == "x" => {
                    answered += 1;
                    result(&uuid, &format!("P{}", answered - 1), &format!("tP{}", answered - 1))
                }
                _ => result(&uuid, &under, &format!("t{parent}")),
            });
            if kind != "r" {
                shown.push(uuid);
            }
        }
        (lines, shown)
    }
    /// The 11 distinct shapes of the 12 commonest `probe2b.cjs` found among the 58 lane branches in the 27 sessions over
    /// 10 MiB (the 12th is the 1st, with the chain on its other lane), each closed by a reply under the shape's last
    /// record on the chain: one chain, every record but the results in file order.
    #[test]
    fn the_lane_shapes_found_are_one_chain() {
        for (case, (found, spec)) in [
            (5, "c0:x r1:x c2:1 r3:0 c4:3 r5:2 c6:5 r7:4 c8:7 n8"),
            (4, "c0:x r1:x c2:1 r3:0 c4:3 r5:2 r6:4 c7:6 n7"),
            (3, "c0:x r1:x c2:1 r3:0 c4:3 r5:2 c6:5 r7:4 n6"),
            (3, "c0:x r1:x c2:1 r3:0 c4:3 c5:4 r6:2 r7:4 r8:5 n8"),
            (2, "c0:x r1:x c2:1 c3:2 r4:x c5:4 r6:0 r7:2 r8:3 r9:5 t10:9 n10"),
            (2, "c0:x r1:x c2:1 c3:2 r4:0 c5:4 r6:2 r7:3 r8:5 n6"),
            (2, "c0:x r1:x c2:1 c3:2 r4:0 c5:4 r6:2 r7:3 r8:5 c9:8 n6"),
            (2, "c0:x r1:x c2:1 r3:0 c4:3 r5:2 r6:4 t7:6 n7"),
            (2, "c0:x r1:x c2:1 c3:2 r4:0 c5:4 r6:2 r7:3 r8:5 c9:8 n9"),
            (2, "c0:x r1:x c2:1 c3:2 r4:0 c5:4 r6:2 r7:3 r8:5 d9:8 n9"),
            (1, "c0:x r1:x c2:1 c3:2 c4:3 r5:0 c6:5 r7:6 t8:7 n8"),
        ]
        .into_iter()
        .enumerate()
        {
            let (lines, shown) = shape(spec);
            let index = fixture(
                &format!("transcript-lane-shape-{case}"),
                &lines.iter().map(String::as_str).collect::<Vec<_>>(),
            );
            let graph = index.transcript.lock().unwrap();
            assert!(graph.ready, "{spec}: {:?}", graph.reason);
            assert_eq!(graph.census.branches, 0, "{spec} (found {found} times)");
            let turns: Vec<_> = shown.iter().map(|uuid| ("turn", uuid.as_str())).collect();
            assert_eq!(order(&graph), turns, "{spec} (found {found} times)");
        }
    }
    /// `lanes` gives a record an earlier parent, but a record can name a later one: a cycle that closes turns the
    /// graph off rather than looping.
    #[test]
    fn a_lane_that_closes_a_cycle_turns_the_graph_off() {
        let lines = [START.to_string(), call("a", "b", "t1", "M"), result("r", "u0", "t1"), call("b", "r", "t2", "M")];
        let index = fixture("transcript-lane-cycle", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let graph = index.transcript.lock().unwrap();
        assert!(!graph.ready);
        assert_eq!(graph.reason.as_deref(), Some(super::CYCLE));
        assert_eq!(graph.charged(), 0);
    }
    /// Reservations come from the structs' sizes (`heap`, `turn_heap`, `finish_temp`). A change to these structs fails
    /// this: then check those still count every field that holds memory. After `finish`, the graph is charged exactly
    /// what it holds.
    #[test]
    fn the_charge_is_what_the_graph_holds() {
        use super::{Climb, Entry, Item, ResultLink, SourceRef, ToolCall, ToolResult, Turn, heap};
        assert_eq!(
            [
                size_of::<SourceRef>(),
                size_of::<ResultLink>(),
                size_of::<ToolCall>(),
                size_of::<ToolResult>(),
                size_of::<Turn>(),
                size_of::<Entry>(),
                size_of::<Item>(),
                size_of::<Climb>(),
            ],
            [40, 24, 152, 112, 120, 200, 64, 24]
        );
        let line = r#"{"messages":[{"role":"system","content":"s"},{"role":"assistant","content":null,"tool_calls":[{"id":"t","function":{"name":"lookup","arguments":"{}"}},{"id":"u","function":{"name":"find","arguments":"{}"}}]},{"role":"tool","tool_call_id":"t","content":"one"},{"role":"tool","tool_call_id":"u","content":"two"}]}"#;
        for (name, lines) in [
            ("transcript-charge-dataset", vec![line; 3]),
            (
                "transcript-charge-claude",
                vec![
                    r#"{"type":"user","uuid":"u0","parentUuid":null,"timestamp":"2026-11-04T12:00:00Z","message":{"role":"user","content":"start"}}"#,
                    r#"{"type":"assistant","uuid":"a1","parentUuid":"u0","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#,
                    r#"{"type":"user","uuid":"u1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r"}]}}"#,
                    r#"{"type":"assistant","uuid":"old","parentUuid":"u1","message":{"role":"assistant","content":"old"}}"#,
                    r#"{"type":"assistant","uuid":"s1","parentUuid":"u1","isSidechain":true,"message":{"role":"assistant","content":"side"}}"#,
                    r#"{"type":"system","uuid":"e1","parentUuid":"u1"}"#,
                    r#"{"type":"assistant","uuid":"new","parentUuid":"e1","message":{"role":"assistant","content":"new"}}"#,
                ],
            ),
        ] {
            let index = fixture(name, &lines);
            let graph = index.transcript.lock().unwrap();
            assert!(graph.ready, "{name}: {:?}", graph.reason);
            let held = graph.entries.capacity() * size_of::<Entry>()
                + graph.items.capacity() * size_of::<Item>()
                + graph.main.capacity() * size_of::<usize>()
                + graph.items.iter().map(|item| item.children.capacity() * size_of::<usize>()).sum::<usize>();
            let held = held as u64 + graph.entries.iter().map(heap).sum::<u64>();
            assert_eq!(graph.charged(), held, "{name}");
            assert_eq!(graph.entries.capacity(), graph.entries.len(), "{name}: finish fits its vectors");
        }
    }
    /// Brief §5.4's OpenAI `arguments`, each a JSON string as the file holds it: what parses, hostile inputs, and what
    /// stays the string (`None`).
    #[test]
    fn arguments_parse_from_their_json_string_or_stay_the_string() {
        use super::{Arguments, Kind};
        use encoding_rs::{UTF_8, WINDOWS_1252};
        let bound = |text: &str| format!("\"{text}\"").into_bytes();
        let piece = super::PIECE_BYTES;
        let tokens: Vec<Vec<u8>> = vec![
            br#""{\"exact\":3.10,\"huge\":1e400,\"digits\":123456789012345678901234567890}""#.to_vec(),
            br#""{\"__proto__\":{\"polluted\":true},\"a\":1,\"a\":2}""#.to_vec(),
            // A lone surrogate escaped in the JSON, and one in the string, which decodes to bytes that aren't UTF-8.
            br#""{\"escaped\":\"\\ud800\",\"decoded\":\"\ud800\"}""#.to_vec(),
            br#""{\"escaped\":\"\\u0000\"}""#.to_vec(),
            // A NUL in the string is a raw control character in the JSON it holds.
            br#""{\"decoded\":\"\u0000\"}""#.to_vec(),
            // JSON in JSON: one level, so the value is a string.
            br#""\"{\\\"a\\\":1}\"""#.to_vec(),
            // 64 KiB of source with its quotes: in the bound, but nested past the scanner's depth.
            bound(&"[".repeat(piece - 2)),
            bound(&"1".repeat(piece - 2)),
            bound(&"1".repeat(piece - 1)),
            br#""{\"a\":""#.to_vec(),
            br#""""#.to_vec(),
            br#""  ""#.to_vec(),
            br#""null""#.to_vec(),
            br#"{}"#.to_vec(),
            br#"null"#.to_vec(),
            br#""a","b""#.to_vec(),
            br#""\uFEFF{}""#.to_vec(),
            // Windows-1252: é is 2 bytes of UTF-8, so the value of 64 KiB of source passes the bound.
            [&b"\"\\\""[..], &[0xE9; 1000], b"\\\"\""].concat(),
            [&b"\"\\\""[..], &[0xE9; 65530], b"\\\"\""].concat(),
        ];
        let file = temp_file("transcript-arguments", &tokens.join(&b'\n'));
        let doc = Document::open(&file).unwrap();
        let mut at = 0;
        let spans: Vec<Span> = tokens
            .iter()
            .map(|token| {
                let span = Span { start: at, end: at + token.len() as u64 };
                at = span.end + 1;
                span
            })
            .collect();
        let read = |i: usize, encoding| Arguments::read(&doc, 1, spans[i], encoding).unwrap();
        let fields = |arguments: &Arguments| -> Vec<(String, String, bool)> {
            let children = arguments.children(0, 0, 128).unwrap();
            children
                .into_iter()
                .map(|(_, c, d)| (arguments.key(c.key.unwrap()), arguments.text(c.value).0, d))
                .collect()
        };
        let field = |key: &str, text: &str, duplicate| (key.to_string(), text.to_string(), duplicate);

        // Numbers as written, not as an f64 has them.
        let numbers = read(0, UTF_8).unwrap();
        assert_eq!((numbers.root.kind, numbers.root.container), (Kind::Object, Some(0)));
        assert_eq!(
            fields(&numbers),
            [
                field("exact", "3.10", false),
                field("huge", "1e400", false),
                field("digits", &"1234567890".repeat(3), false)
            ]
        );
        let page = numbers.children(0, 1, 1).unwrap();
        assert_eq!((page.len(), page[0].0, numbers.text(page[0].1.value).0), (1, 1, "1e400".into()));
        // Its bytes and its index are both reserved.
        assert_eq!(numbers._charge.bytes(), 7 * tokens[0].len() as u64);
        assert!(numbers.index.charged() > 0);
        // `__proto__` is a key like any other, and a repeated key is kept and flagged.
        let keys = read(1, UTF_8).unwrap();
        assert_eq!(fields(&keys)[1..], [field("a", "1", false), field("a", "2", true)]);
        assert_eq!(fields(&keys)[0].0, "__proto__");
        assert_eq!(
            fields(&read(2, UTF_8).unwrap()),
            [field("escaped", r#""\ud800""#, false), field("decoded", "\"\u{FFFD}\u{FFFD}\u{FFFD}\"", false)]
        );
        assert_eq!(fields(&read(3, UTF_8).unwrap()), [field("escaped", r#""\u0000""#, false)]);
        assert!(read(4, UTF_8).is_none());
        let nested = read(5, UTF_8).unwrap();
        assert_eq!((nested.root.kind, nested.root.container), (Kind::String, None));
        assert_eq!(nested.text(nested.root.value), (r#""{\"a\":1}""#.into(), false));
        assert!(read(6, UTF_8).is_none());
        // At the bound a value parses, its text cut as a Tree's is; one byte past it, it stays the string.
        let long = read(7, UTF_8).unwrap();
        assert_eq!(long.text(long.root.value), ("1".repeat(4096), true));
        assert!(read(8, UTF_8).is_none());
        for i in 9..12 {
            assert!(read(i, UTF_8).is_none(), "{i}");
        }
        assert_eq!(read(12, UTF_8).unwrap().root.kind, Kind::Null);
        for i in 13..17 {
            assert!(read(i, UTF_8).is_none(), "{i}");
        }
        let text = read(17, WINDOWS_1252).unwrap();
        assert_eq!(text.text(text.root.value).0, format!("\"{}\"", "é".repeat(1000)));
        assert!(read(18, WINDOWS_1252).is_none());
    }
}
