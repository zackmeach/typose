//! JSON/JSONC structural scanner (spec §4.3, §3.5). It records spans only, so every displayed value is a slice
//! of the source and the Tree is lossless by construction. One streaming pass over `ByteStore` chunks builds the
//! container index; children are enumerated lazily from the nearest element checkpoint.
use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;

use memchr::{memchr, memchr_iter, memchr2, memrchr};
use xxhash_rust::xxh3::{Xxh3, xxh3_128};

use crate::budget::{OverBudget, Reservation};
use crate::store::{ByteStore, CHUNK, StoreError};
const MAX_PAGE: usize = 64 << 10;
const MAX_PIECE: usize = 4096;

/// `[start, end)` in original file bytes (spec §3.2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Object,
    Array,
    String,
    Number,
    True,
    False,
    Null,
}

/// One object or array: 32 bytes, so the index costs 32 bytes per container (spec §3.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Container {
    pub start: u64,
    /// One past the closing bracket; 0 while unclosed (the scan stopped inside it).
    pub end: u64,
    pub children: u64,
    pub kind: Kind,
}

/// Where child `child` of `container` starts (its key, for objects).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElementCheckpoint {
    pub container: u32,
    pub child: u64,
    pub offset: u64,
}

/// JSONC features, counted rather than stored. All zero means the document is strict JSON.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Trivia {
    pub comments: u64,
    pub trailing_commas: u64,
    /// `NaN`, `Infinity` and `-Infinity` (brief §5.5 lists them with JSONC).
    pub nonfinite: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Syntax(&'static str),
    /// Nesting deeper than `MAX_DEPTH`.
    TooDeep,
    /// More containers than `MAX_CONTAINERS`.
    TooManyContainers,
    Cancelled,
    Memory(OverBudget),
}

/// Where the scan stopped. `line` and `column` are 1-based within the scanned range, and `column` counts
/// characters. Both are 0 for `Cancelled`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanError {
    pub kind: ErrorKind,
    pub offset: u64,
    pub line: u64,
    pub column: u64,
}

/// Deeper nesting stops the scan with `TooDeep`. At 10,000 the index and stack hold about 560 KB.
const MAX_DEPTH: usize = 10_000;
/// More containers stop the scan with `TooManyContainers`. The records are charged to the memory budget (spec §3.6)
/// and paged at 32 bytes per container, so growth adds at most one 128 KiB page.
const MAX_CONTAINERS: usize = u32::MAX as usize;
/// An element checkpoint every `CP_CHILDREN` children or `CP_BYTES` bytes, whichever comes first (spec §3.5).
const CP_CHILDREN: u64 = 1024;
const CP_BYTES: u64 = 1 << 20;
/// Bytes per step. Cancellation is checked before every step, and enumeration reads this much at a time.
const WINDOW: usize = 64 << 10;

/// A vector kept in pages of 4,096 elements, so growing it never moves more than one page. A plain `Vec`
/// doubling past 2^24 containers copied 537 MB in one push and held off cancellation for up to 88 ms.
#[derive(Debug)]
pub struct Paged<T> {
    pages: Vec<Vec<T>>,
    len: usize,
    charge: Reservation,
}

const PAGE: usize = 4096;
pub(crate) fn room<T>(values: &mut Vec<T>, charge: &mut Reservation) -> Result<(), OverBudget> {
    if values.len() == values.capacity() {
        let old = values.capacity();
        let next = old.max(32) * 2;
        charge.grow((next * size_of::<T>()) as u64)?;
        values.reserve_exact(next - values.len());
        charge.shrink((old * size_of::<T>()) as u64);
    }
    Ok(())
}

impl<T> Paged<T> {
    fn new() -> Self {
        Paged { pages: Vec::new(), len: 0, charge: Reservation::none() }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn get(&self, i: usize) -> Option<&T> {
        self.pages.get(i / PAGE)?.get(i % PAGE)
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.pages.iter().flatten()
    }

    /// The first index where `pred` turns false; `pred` must hold for a prefix of the elements.
    pub fn partition_point(&self, pred: impl Fn(&T) -> bool) -> usize {
        let p = self.pages.partition_point(|page| page.last().is_some_and(&pred));
        self.pages.get(p).map_or(self.len, |page| p * PAGE + page.partition_point(&pred))
    }

    fn push(&mut self, v: T) -> Result<(), OverBudget> {
        if self.pages.last().is_none_or(|p| p.len() == PAGE) {
            room(&mut self.pages, &mut self.charge)?;
            self.charge.grow((PAGE * size_of::<T>()) as u64)?;
            self.pages.push(Vec::with_capacity(PAGE));
        }
        self.pages.last_mut().unwrap().push(v);
        self.len += 1;
        Ok(())
    }
}

impl<T> std::ops::Index<usize> for Paged<T> {
    type Output = T;
    fn index(&self, i: usize) -> &T {
        &self.pages[i / PAGE][i % PAGE]
    }
}

impl<T> std::ops::IndexMut<usize> for Paged<T> {
    fn index_mut(&mut self, i: usize) -> &mut T {
        &mut self.pages[i / PAGE][i % PAGE]
    }
}

#[derive(Debug)]
pub struct JsonIndex {
    pub range: Span,
    /// The top-level value. A container root is `containers[0]`.
    pub root: Option<(Kind, Span)>,
    /// Every object and array in document order, so `start` ascends.
    pub containers: Paged<Container>,
    /// Sorted by container, then child.
    pub checkpoints: Vec<ElementCheckpoint>,
    /// Strings (keys included) and numbers of at least `MAX_PIECE` bytes, by start. Enumeration jumps over them.
    pub long_scalars: Vec<Span>,
    pub trivia: Trivia,
    pub error: Option<ScanError>,
    allocation_error: Option<OverBudget>,
    charge: Reservation,
}

/// One child of a container, as enumeration returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Child {
    /// The key token, quotes included (objects only).
    pub key: Option<Span>,
    pub value: Span,
    pub kind: Kind,
    /// The container's id, for objects and arrays.
    pub container: Option<u32>,
    /// Scalars only: the verbatim source bytes, at most `MAX_PIECE` of them.
    pub text: Vec<u8>,
}

impl JsonIndex {
    pub fn charged(&self) -> u64 {
        self.charge.bytes() + self.containers.charge.bytes()
    }

    /// Enumeration never reads past this: the error offset, or the end of the range.
    fn stop(&self) -> u64 {
        self.error.map_or(self.range.end, |e| e.offset)
    }

    fn checkpoints_of(&self, id: u32) -> &[ElementCheckpoint] {
        let lo = self.checkpoints.partition_point(|c| c.container < id);
        let hi = self.checkpoints.partition_point(|c| c.container <= id);
        &self.checkpoints[lo..hi]
    }
}

/// Builds the container index for `range` of the store (the whole file, or one JSONL record).
/// Syntax, depth, budget and cancel (`store::cancellable`) errors land in `JsonIndex::error`, with everything before
/// them kept. `jsonc` accepts `//` and `/* */` comments, trailing commas and `NaN`/`Infinity` (`.json` falls back to
/// JSONC, spec §4.1).
pub fn scan(store: &ByteStore, range: Range<u64>, jsonc: bool) -> Result<JsonIndex, StoreError> {
    let end = range.end.min(store.len());
    let mut start = range.start.min(end);
    if start == 0 && store.read(0, end.min(3))? == b"\xEF\xBB\xBF" {
        start = 3; // a UTF-8 BOM at the file's start (spec §4.1): the document starts after it
    }
    let mut s = Scanner::new(jsonc, Span { start, end });
    let mut pos = start;
    let stopped = 'scan: {
        while pos < end {
            if crate::store::cancelled() {
                break 'scan Some((ErrorKind::Cancelled, pos));
            }
            let bytes = store.read(pos, (pos + WINDOW as u64).min(end))?;
            if bytes.is_empty() {
                break;
            }
            if let Err(e) = s.feed(&bytes, pos) {
                break 'scan Some(e);
            }
            pos += bytes.len() as u64;
        }
        if let Some(e) = s.idx.allocation_error {
            Some((ErrorKind::Memory(e), pos))
        } else {
            s.finish(pos).err().or_else(|| s.idx.allocation_error.map(|e| (ErrorKind::Memory(e), pos)))
        }
    };
    if let Some((kind, offset)) = stopped {
        s.on_error();
        let (line, column) = if kind == ErrorKind::Cancelled { (0, 0) } else { line_col(store, start, offset)? };
        s.idx.error = Some(ScanError { kind, offset, line, column });
    }
    let mut idx = s.idx;
    idx.checkpoints.sort_unstable_by_key(|c| (c.container, c.child));
    if let Some(page) = idx.containers.pages.last_mut() {
        page.shrink_to_fit(); // at most one page moves
    }
    Ok(idx)
}

/// Up to `count` children of `container`, starting at child `first`, holding at most `MAX_PAGE` bytes of text,
/// checked before each push (spec §3.4): the next page starts after the last child returned. Starts at the nearest
/// checkpoint, jumps over nested containers through the index and over long scalars through `long_scalars`.
pub fn children(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    first: u64,
    count: usize,
) -> Result<Vec<Child>, StoreError> {
    let (mut out, mut bytes) = (Vec::new(), 0);
    if count == 0 {
        return Ok(out);
    }
    walk(store, index, container, first, |cur, mut child| {
        if !matches!(child.kind, Kind::Object | Kind::Array) {
            let v = child.value;
            child.text = cur.read(Span { start: v.start, end: v.end.min(v.start + MAX_PIECE as u64) })?.into_owned();
        }
        if !out.is_empty() && bytes + child.text.len() > MAX_PAGE {
            return Ok(false);
        }
        bytes += child.text.len();
        out.push(child);
        Ok(out.len() < count)
    })?;
    Ok(out)
}

/// Ordinals of the members of object `container` whose key, unescaped, repeats an earlier member's key, or
/// `None` if cancelled (checked every 1,024 members). Runs over the whole object once; the Tree calls it when
/// the object is first expanded. While it runs it holds a pre-sized set of 128-bit key hashes: 17–34 bytes
/// per member (136 MB for a 5M-key object).
pub fn duplicate_keys(store: &ByteStore, index: &JsonIndex, container: u32) -> Result<Option<Vec<u64>>, StoreError> {
    let members = index.containers.get(container as usize).filter(|c| c.kind == Kind::Object).map_or(0, |c| c.children);
    let (mut seen, mut dups, mut ordinal) = (HashSet::with_capacity(members as usize), Vec::new(), 0u64);
    let mut cancelled = false;
    walk(store, index, container, 0, |cur, child| {
        if ordinal % 1024 == 0 && crate::store::cancelled() {
            cancelled = true;
            return Ok(false);
        }
        if let Some(key) = child.key {
            let hash = if key.end - key.start > MAX_PIECE as u64 {
                // ponytail: keys over 64 KiB are compared by raw bytes, escapes undecoded; streamed, never buffered.
                let mut h = Xxh3::new();
                let mut pos = key.start;
                while pos < key.end {
                    let piece = store.read(pos, key.end.min(pos + CHUNK as u64))?;
                    if piece.is_empty() {
                        break;
                    }
                    h.update(&piece);
                    pos += piece.len() as u64;
                }
                h.digest128()
            } else {
                xxh3_128(&unescape(&cur.read(key)?))
            };
            if !seen.insert(hash) {
                dups.push(ordinal);
            }
        }
        ordinal += 1;
        Ok(true)
    })?;
    Ok((!cancelled).then_some(dups))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    Root,
    Value,
    ArrFirst,
    ArrNext,
    ObjFirst,
    ObjNext,
    Colon,
    After,
    Done,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Num {
    Minus,
    Zero,
    Int,
    Dot,
    Frac,
    Exp,
    ExpSign,
    ExpDigits,
}

/// Lexer state. It survives between `feed` calls, so a token may straddle any chunk or window boundary.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lex {
    Between,
    Str,
    Escape,
    Hex(u8),
    Num(Num),
    Word(&'static [u8], u8),
    Slash,
    LineComment,
    BlockComment,
    BlockStar,
}

struct Frame {
    id: u32,
    cp_child: u64,
    cp_offset: u64,
}

type Stop = (ErrorKind, u64);

/// Push scanner: no recursion, so file-controlled depth only grows `stack`, which `MAX_DEPTH` caps.
struct Scanner {
    jsonc: bool,
    idx: JsonIndex,
    stack: Vec<Frame>,
    expect: Expect,
    lex: Lex,
    tok: u64,
    tok_kind: Kind,
    tok_is_key: bool,
    /// The innermost container's current child has started but not finished.
    in_child: bool,
}

fn num_next(n: Num, b: u8) -> Option<Num> {
    match (n, b) {
        (Num::Minus, b'0') => Some(Num::Zero),
        (Num::Minus, b'1'..=b'9') | (Num::Int, b'0'..=b'9') => Some(Num::Int),
        (Num::Zero | Num::Int, b'.') => Some(Num::Dot),
        (Num::Dot | Num::Frac, b'0'..=b'9') => Some(Num::Frac),
        (Num::Zero | Num::Int | Num::Frac, b'e' | b'E') => Some(Num::Exp),
        (Num::Exp, b'+' | b'-') => Some(Num::ExpSign),
        (Num::Exp | Num::ExpSign | Num::ExpDigits, b'0'..=b'9') => Some(Num::ExpDigits),
        _ => None,
    }
}

impl Scanner {
    fn new(jsonc: bool, range: Span) -> Self {
        let idx = JsonIndex {
            range,
            root: None,
            containers: Paged::new(),
            checkpoints: Vec::new(),
            long_scalars: Vec::new(),
            trivia: Trivia::default(),
            error: None,
            allocation_error: None,
            charge: Reservation::none(),
        };
        Scanner {
            jsonc,
            idx,
            stack: Vec::new(),
            expect: Expect::Root,
            lex: Lex::Between,
            tok: range.start,
            tok_kind: Kind::Null,
            tok_is_key: false,
            in_child: false,
        }
    }

    fn feed(&mut self, buf: &[u8], base: u64) -> Result<(), Stop> {
        let mut i = 0;
        while i < buf.len() {
            let at = base + i as u64;
            if let Some(e) = self.idx.allocation_error {
                return Err((ErrorKind::Memory(e), at));
            }
            match self.lex {
                Lex::Between => {
                    let b = buf[i];
                    i += 1;
                    if !matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                        self.token(b, at)?;
                    }
                }
                Lex::Str => match buf[i..].iter().position(|b| *b == b'"' || *b == b'\\' || *b < 0x20) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        if buf[i - 1] < 0x20 {
                            return Err((ErrorKind::Syntax("unescaped control in string"), base + i as u64 - 1));
                        }
                        if buf[i - 1] == b'"' {
                            self.end_string(base + i as u64);
                        } else {
                            self.lex = Lex::Escape;
                        }
                    }
                },
                Lex::Escape => {
                    self.lex = match buf[i] {
                        b'u' => Lex::Hex(4),
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => Lex::Str,
                        _ => return Err((ErrorKind::Syntax("invalid escape"), at)),
                    };
                    i += 1;
                }
                Lex::Hex(left) => {
                    if !buf[i].is_ascii_hexdigit() {
                        return Err((ErrorKind::Syntax("invalid escape"), at));
                    }
                    self.lex = if left == 1 { Lex::Str } else { Lex::Hex(left - 1) };
                    i += 1;
                }
                Lex::Num(Num::Minus) if buf[i] == b'I' && self.jsonc => {
                    self.idx.trivia.nonfinite += 1;
                    self.lex = Lex::Word(b"Infinity", 1);
                    i += 1;
                }
                Lex::Num(mut n) => {
                    while let Some(next) = buf.get(i).and_then(|&b| num_next(n, b)) {
                        n = next;
                        i += 1;
                    }
                    self.lex = Lex::Num(n);
                    // A byte that can't continue the number ends it; that byte is looked at again as `Between`.
                    if i < buf.len() {
                        if !matches!(n, Num::Zero | Num::Int | Num::Frac | Num::ExpDigits) {
                            return Err((ErrorKind::Syntax("invalid number"), base + i as u64));
                        }
                        self.end_scalar(base + i as u64);
                    }
                }
                Lex::Word(word, k) => {
                    if buf[i] != word[k as usize] {
                        return Err((ErrorKind::Syntax("invalid literal"), at));
                    }
                    i += 1;
                    if k as usize + 1 == word.len() {
                        self.end_scalar(base + i as u64);
                    } else {
                        self.lex = Lex::Word(word, k + 1);
                    }
                }
                Lex::Slash => {
                    self.lex = match buf[i] {
                        b'/' => Lex::LineComment,
                        b'*' => Lex::BlockComment,
                        _ => return Err((ErrorKind::Syntax("invalid comment"), self.tok)),
                    };
                    self.idx.trivia.comments += 1;
                    i += 1;
                }
                Lex::LineComment => match memchr2(b'\n', b'\r', &buf[i..]) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        self.lex = Lex::Between;
                    }
                },
                Lex::BlockComment => match memchr(b'*', &buf[i..]) {
                    None => i = buf.len(),
                    Some(j) => {
                        i += j + 1;
                        self.lex = Lex::BlockStar;
                    }
                },
                Lex::BlockStar => {
                    self.lex = match buf[i] {
                        b'/' => Lex::Between,
                        b'*' => Lex::BlockStar,
                        _ => Lex::BlockComment,
                    };
                    i += 1;
                }
            }
        }
        Ok(())
    }

    fn token(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        match b {
            b'"' if matches!(self.expect, Expect::ObjFirst | Expect::ObjNext) => {
                self.child_start(at);
                (self.tok, self.tok_is_key, self.lex) = (at, true, Lex::Str);
                Ok(())
            }
            b'"' => self.value(at, Lex::Str, Kind::String),
            b'{' | b'[' => {
                self.value_start(at)?;
                self.open(b, at)
            }
            b'-' => self.value(at, Lex::Num(Num::Minus), Kind::Number),
            b'0' => self.value(at, Lex::Num(Num::Zero), Kind::Number),
            b'1'..=b'9' => self.value(at, Lex::Num(Num::Int), Kind::Number),
            b't' => self.value(at, Lex::Word(b"true", 1), Kind::True),
            b'f' => self.value(at, Lex::Word(b"false", 1), Kind::False),
            b'n' => self.value(at, Lex::Word(b"null", 1), Kind::Null),
            b'N' | b'I' if self.jsonc => {
                let word: &'static [u8] = if b == b'N' { b"NaN" } else { b"Infinity" };
                self.value(at, Lex::Word(word, 1), Kind::Number)?;
                self.idx.trivia.nonfinite += 1;
                Ok(())
            }
            b',' if self.expect == Expect::After => {
                self.expect = if self.top_kind() == Some(Kind::Object) { Expect::ObjNext } else { Expect::ArrNext };
                Ok(())
            }
            b':' if self.expect == Expect::Colon => {
                self.expect = Expect::Value;
                Ok(())
            }
            b']' | b'}' => self.close(b, at),
            b'/' if self.jsonc => {
                (self.tok, self.lex) = (at, Lex::Slash);
                Ok(())
            }
            _ => Err(self.unexpected(at)),
        }
    }

    fn value(&mut self, at: u64, lex: Lex, kind: Kind) -> Result<(), Stop> {
        self.value_start(at)?;
        (self.tok, self.tok_kind, self.tok_is_key, self.lex) = (at, kind, false, lex);
        Ok(())
    }

    fn value_start(&mut self, at: u64) -> Result<(), Stop> {
        match self.expect {
            Expect::Root | Expect::Value => Ok(()),
            Expect::ArrFirst | Expect::ArrNext => {
                self.child_start(at);
                Ok(())
            }
            _ => Err(self.unexpected(at)),
        }
    }

    /// Counts a child of the innermost container and places a checkpoint at it when one is due.
    fn child_start(&mut self, at: u64) {
        let Some(f) = self.stack.last_mut() else { return };
        self.in_child = true;
        let c = &mut self.idx.containers[f.id as usize];
        let k = c.children;
        c.children += 1;
        if k - f.cp_child >= CP_CHILDREN || at - f.cp_offset >= CP_BYTES {
            if let Err(e) = room(&mut self.idx.checkpoints, &mut self.idx.charge) {
                self.idx.allocation_error = Some(e);
                return;
            }
            self.idx.checkpoints.push(ElementCheckpoint { container: f.id, child: k, offset: at });
            (f.cp_child, f.cp_offset) = (k, at);
        }
    }

    fn open(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        if self.stack.len() >= MAX_DEPTH {
            return Err((ErrorKind::TooDeep, at));
        }
        if self.idx.containers.len() >= MAX_CONTAINERS {
            return Err((ErrorKind::TooManyContainers, at));
        }
        let kind = if b == b'{' { Kind::Object } else { Kind::Array };
        let id = self.idx.containers.len() as u32;
        if self.stack.is_empty() {
            self.idx.root = Some((kind, Span { start: at, end: 0 }));
        }
        self.idx
            .containers
            .push(Container { start: at, end: 0, children: 0, kind })
            .map_err(|e| (ErrorKind::Memory(e), at))?;
        self.stack.push(Frame { id, cp_child: 0, cp_offset: at });
        self.expect = if kind == Kind::Object { Expect::ObjFirst } else { Expect::ArrFirst };
        self.in_child = false;
        Ok(())
    }

    fn close(&mut self, b: u8, at: u64) -> Result<(), Stop> {
        let kind = if b == b'}' { Kind::Object } else { Kind::Array };
        let ok = match self.expect {
            Expect::After => self.top_kind() == Some(kind),
            Expect::ArrFirst => kind == Kind::Array,
            Expect::ObjFirst => kind == Kind::Object,
            Expect::ArrNext | Expect::ObjNext if self.jsonc && self.top_kind() == Some(kind) => {
                self.idx.trivia.trailing_commas += 1;
                true
            }
            _ => false,
        };
        if !ok {
            return Err(self.unexpected(at));
        }
        let Some(f) = self.stack.pop() else { return Err(self.unexpected(at)) };
        self.idx.containers[f.id as usize].end = at + 1;
        if let (true, Some((_, span))) = (self.stack.is_empty(), &mut self.idx.root) {
            span.end = at + 1;
        }
        self.after_value();
        Ok(())
    }

    fn end_string(&mut self, end: u64) {
        if self.tok_is_key {
            self.note_long(end);
            (self.lex, self.expect) = (Lex::Between, Expect::Colon);
        } else {
            self.end_scalar(end);
        }
    }

    fn end_scalar(&mut self, end: u64) {
        self.lex = Lex::Between;
        self.note_long(end);
        if self.stack.is_empty() {
            self.idx.root = Some((self.tok_kind, Span { start: self.tok, end }));
        }
        self.after_value();
    }

    fn note_long(&mut self, end: u64) {
        if end - self.tok >= MAX_PIECE as u64 {
            if let Err(e) = room(&mut self.idx.long_scalars, &mut self.idx.charge) {
                self.idx.allocation_error = Some(e);
                return;
            }
            self.idx.long_scalars.push(Span { start: self.tok, end });
        }
    }

    fn after_value(&mut self) {
        self.in_child = false;
        self.expect = if self.stack.is_empty() { Expect::Done } else { Expect::After };
    }

    fn top_kind(&self) -> Option<Kind> {
        self.stack.last().map(|f| self.idx.containers[f.id as usize].kind)
    }

    fn unexpected(&self, at: u64) -> Stop {
        let msg = match self.expect {
            Expect::Root | Expect::Value | Expect::ArrNext => "expected a value",
            Expect::ArrFirst => "expected a value or ]",
            Expect::ObjFirst => "expected a key or }",
            Expect::ObjNext => "expected a key",
            Expect::Colon => "expected :",
            Expect::After if self.top_kind() == Some(Kind::Object) => "expected , or }",
            Expect::After => "expected , or ]",
            Expect::Done => "unexpected data after the value",
        };
        (ErrorKind::Syntax(msg), at)
    }

    fn finish(&mut self, end: u64) -> Result<(), Stop> {
        match self.lex {
            Lex::Between | Lex::LineComment => {}
            Lex::Num(Num::Zero | Num::Int | Num::Frac | Num::ExpDigits) => self.end_scalar(end),
            Lex::Str | Lex::Escape | Lex::Hex(_) => {
                return Err((ErrorKind::Syntax("unexpected end of input"), self.tok));
            }
            Lex::Slash | Lex::BlockComment | Lex::BlockStar => {
                return Err((ErrorKind::Syntax("unterminated comment"), self.tok));
            }
            Lex::Num(_) | Lex::Word(..) => return Err((ErrorKind::Syntax("unexpected end of input"), end)),
        }
        match self.expect {
            Expect::Root | Expect::Done => Ok(()),
            _ => Err((ErrorKind::Syntax("unexpected end of input"), end)),
        }
    }

    /// A child cut off by the error isn't counted, so `children` counts only what enumeration can return.
    /// An unclosed nested container still counts: what parsed inside it stays usable.
    fn on_error(&mut self) {
        if let (true, Some(f)) = (self.in_child, self.stack.last()) {
            let c = &mut self.idx.containers[f.id as usize];
            c.children = c.children.saturating_sub(1);
        }
    }
}

/// 1-based line and character column of `offset`, counted from `from`; (0, 0) if cancelled first.
fn line_col(store: &ByteStore, from: u64, offset: u64) -> Result<(u64, u64), StoreError> {
    let (mut line, mut column, mut pos) = (1u64, 1u64, from);
    while pos < offset {
        if crate::store::cancelled() {
            return Ok((0, 0));
        }
        let bytes = store.read(pos, offset.min(pos + WINDOW as u64))?;
        if bytes.is_empty() {
            break;
        }
        let tail = match memrchr(b'\n', &bytes) {
            Some(i) => {
                line += memchr_iter(b'\n', &bytes).count() as u64;
                column = 1;
                &bytes[i + 1..]
            }
            None => &bytes[..],
        };
        column += tail.iter().filter(|&&b| b & 0xC0 != 0x80).count() as u64;
        pos += bytes.len() as u64;
    }
    Ok((line, column))
}

/// Pull reader for enumeration: `[pos, end)` through the store, `WINDOW` bytes at a time.
struct Cursor<'s> {
    store: &'s ByteStore,
    pos: u64,
    end: u64,
    buf: Vec<u8>,
    buf_start: u64,
}

impl Cursor<'_> {
    /// The buffered bytes from `pos` on, refilled when used up; empty at `end`.
    fn rest(&mut self) -> Result<&[u8], StoreError> {
        if self.pos < self.buf_start || self.pos >= self.buf_start + self.buf.len() as u64 {
            self.buf = self.store.read(self.pos, self.end.min(self.pos + WINDOW as u64))?;
            self.buf_start = self.pos;
        }
        Ok(&self.buf[(self.pos - self.buf_start) as usize..])
    }

    fn peek(&mut self) -> Result<Option<u8>, StoreError> {
        Ok(self.rest()?.first().copied())
    }

    /// Moves just past the first byte `find` locates, or to `end`.
    fn skip_past(&mut self, find: impl Fn(&[u8]) -> Option<usize>) -> Result<(), StoreError> {
        loop {
            let rest = self.rest()?;
            let (len, hit) = (rest.len(), find(rest));
            match hit {
                Some(j) => {
                    self.pos += j as u64 + 1;
                    return Ok(());
                }
                None if len == 0 => return Ok(()),
                None => self.pos += len as u64,
            }
        }
    }

    /// `span`'s bytes, from the buffer when it holds them.
    fn read(&mut self, span: Span) -> Result<Cow<'_, [u8]>, StoreError> {
        let buf_end = self.buf_start + self.buf.len() as u64;
        if span.start >= self.buf_start && span.end <= buf_end {
            let (a, b) = ((span.start - self.buf_start) as usize, (span.end - self.buf_start) as usize);
            return Ok(Cow::Borrowed(&self.buf[a..b]));
        }
        Ok(Cow::Owned(self.store.read(span.start, span.end)?))
    }

    /// Skips whitespace, commas, colons and comments (the scan already validated them) to the next token.
    fn next_token(&mut self) -> Result<Option<(u64, u8)>, StoreError> {
        loop {
            let Some(b) = self.peek()? else { return Ok(None) };
            match b {
                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' => self.pos += 1,
                b'/' => {
                    self.pos += 1;
                    if self.peek()? == Some(b'*') {
                        self.pos += 1;
                        loop {
                            self.skip_past(|s| memchr(b'*', s))?;
                            match self.peek()? {
                                Some(b'/') => {
                                    self.pos += 1;
                                    break;
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                    } else {
                        self.skip_past(|s| memchr2(b'\n', b'\r', s))?;
                    }
                }
                _ => return Ok(Some((self.pos, b))),
            }
        }
    }

    /// End of the string, number or literal that starts at `start` with byte `first`.
    fn scalar_end(&mut self, index: &JsonIndex, start: u64, first: u8) -> Result<u64, StoreError> {
        if let Ok(i) = index.long_scalars.binary_search_by_key(&start, |s| s.start) {
            self.pos = index.long_scalars[i].end;
            return Ok(self.pos);
        }
        self.pos = start + 1;
        loop {
            let rest = self.rest()?;
            let len = rest.len();
            if first == b'"' {
                match memchr2(b'"', b'\\', rest).map(|j| (j, rest[j])) {
                    Some((j, b'"')) => return Ok(self.pos + j as u64 + 1),
                    Some((j, _)) => self.pos += j as u64 + 2, // a backslash and the byte it escapes
                    None if len == 0 => return Ok(self.pos),
                    None => self.pos += len as u64,
                }
            } else {
                let delim = |b: &u8| matches!(b, b',' | b']' | b'}' | b':' | b' ' | b'\t' | b'\n' | b'\r' | b'/');
                match rest.iter().position(delim) {
                    Some(j) => return Ok(self.pos + j as u64),
                    None if len == 0 => return Ok(self.pos),
                    None => self.pos += len as u64,
                }
            }
        }
    }
}

fn scalar_kind(first: u8) -> Kind {
    match first {
        b'"' => Kind::String,
        b't' => Kind::True,
        b'f' => Kind::False,
        b'n' => Kind::Null,
        _ => Kind::Number,
    }
}

/// Visits the children of `container` from child `first` on, until `visit` returns false.
fn walk(
    store: &ByteStore,
    index: &JsonIndex,
    container: u32,
    first: u64,
    mut visit: impl FnMut(&mut Cursor<'_>, Child) -> Result<bool, StoreError>,
) -> Result<(), StoreError> {
    let Some(c) = index.containers.get(container as usize).filter(|c| first < c.children) else { return Ok(()) };
    let cps = index.checkpoints_of(container);
    let (mut ordinal, from) = match cps.partition_point(|cp| cp.child <= first) {
        0 => (0, c.start + 1),
        i => (cps[i - 1].child, cps[i - 1].offset),
    };
    let stop = if c.end > 0 { c.end.min(index.stop()) } else { index.stop() }; // never read past the container
    let mut cur = Cursor { store, pos: from, end: stop, buf: Vec::new(), buf_start: from };
    while ordinal < c.children {
        let key = match c.kind {
            Kind::Object => {
                let Some((at, b)) = cur.next_token()? else { break };
                let end = cur.scalar_end(index, at, b)?;
                cur.pos = end;
                Some(Span { start: at, end })
            }
            _ => None,
        };
        let Some((at, b)) = cur.next_token()? else { break };
        let (kind, end, id) = match b {
            b'{' | b'[' => {
                let i = index.containers.partition_point(|c| c.start < at);
                let id = index.containers.get(i).filter(|c| c.start == at).map(|_| i);
                let end = id.map_or(0, |i| index.containers[i].end);
                let kind = if b == b'{' { Kind::Object } else { Kind::Array };
                (kind, if end == 0 { stop } else { end }, id.map(|i| i as u32))
            }
            _ => (scalar_kind(b), cur.scalar_end(index, at, b)?, None),
        };
        cur.pos = end;
        if ordinal >= first
            && !visit(&mut cur, Child { key, value: Span { start: at, end }, kind, container: id, text: Vec::new() })?
        {
            break;
        }
        ordinal += 1;
    }
    Ok(())
}

/// A string token (quotes included) with its escapes decoded. Other bytes, even invalid UTF-8, pass through.
pub fn unescape(tok: &[u8]) -> Cow<'_, [u8]> {
    let s = tok.strip_prefix(b"\"").unwrap_or(tok);
    let s = s.strip_suffix(b"\"").unwrap_or(s);
    if memchr(b'\\', s).is_none() {
        return Cow::Borrowed(s);
    }
    let hex = |i: usize| {
        s.get(i..i + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok())
    };
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'\\' {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let Some(&e) = s.get(i + 1) else { break };
        let mut cp = match e {
            b'u' => hex(i + 2).unwrap_or(0xFFFD),
            b'b' => 8,
            b'f' => 12,
            b'n' => 10,
            b'r' => 13,
            b't' => 9,
            other => other as u32,
        };
        i += if e == b'u' { 6 } else { 2 };
        if (0xD800..0xDC00).contains(&cp)
            && s.get(i..i + 2) == Some(&b"\\u"[..])
            && let Some(lo @ 0xDC00..=0xDFFF) = hex(i + 2)
        {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            i += 6;
        }
        push_utf8(&mut out, cp);
    }
    Cow::Owned(out)
}

/// UTF-8 encoding that also encodes lone surrogates (as WTF-8 does), so every code unit compares exactly.
fn push_utf8(out: &mut Vec<u8>, cp: u32) {
    let cont = |shift: u32| 0x80 | ((cp >> shift) & 0x3F) as u8;
    match cp {
        0..=0x7F => out.push(cp as u8),
        0x80..=0x7FF => out.extend([0xC0 | (cp >> 6) as u8, cont(0)]),
        0x800..=0xFFFF => out.extend([0xE0 | (cp >> 12) as u8, cont(6), cont(0)]),
        _ => out.extend([0xF0 | (cp >> 18) as u8, cont(12), cont(6), cont(0)]),
    }
}
