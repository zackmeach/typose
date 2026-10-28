//! Rendered Markdown (spec §4.6; plan: Rendered Markdown slice §2.1). One whole-file parse, up to `MAX_SOURCE`, from
//! one verified read: each top-level block becomes an item of sanitized HTML, which pages then slice (spec §3.4).
//!
//! **Each block, in three steps.** pulldown-cmark's events go to its own HTML writer (`html::write_html_fmt`), rewritten
//! on the way (`Events`): raw `Html` and `InlineHtml` through `sanitize::escape_raw`, links to `<a data-href>`, and
//! footnotes numbered across the file. Then `sanitize` cleans what it wrote, until a pass changes nothing (`clean`). A
//! block over 64 KiB of source, nested deeper than `MAX_DEPTH` or writing more than `HTML_MAX` is never rendered: it's a
//! note (brief §5.2's fallback).
//!
//! **Memory (plan C1, Z34 🔒).** The read and its decode are reserved before the read, and the parse's temporaries
//! before the parse (`parse_temp`). The items grow their own reservation as each is made. A refusal ends the build with
//! `Memory`, and nothing stays charged: everything it held drops with it.
use std::collections::HashMap;
use std::fmt;
use std::ops::Range;
use std::path::Path;

use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd, html};

use crate::budget::{OverBudget, Reservation};
use crate::doc::{DocError, Document};
use crate::pages::{MAX_ITEMS, MAX_PATH_BYTES, PAGE_BYTES, PIECE_BYTES};
use crate::sanitize::{escape_attr, escape_raw, escape_text, sanitize};
use crate::store::CHUNK;

/// Z71: Rendered shows files of up to 8 MiB of source. Raw shows any file.
pub const MAX_SOURCE: u64 = 8 << 20;
/// Z44: front matter must close within the file's first 64 KiB.
const FRONT_MATTER: usize = 64 << 10;
/// Spike C's `MAX_DEPTH`: a block nested deeper is a note (Chromium's parser flattens past 512 levels anyway).
pub const MAX_DEPTH: usize = 64;
/// The most HTML a block may write, and keep once sanitized: spec §3.4's 256 KiB page.
pub const HTML_MAX: usize = PAGE_BYTES;
/// The build checks its cancel flag this often, in parser events (plan §2.1).
const CANCEL_EVERY: usize = 1024;

/// CommonMark with GFM's tables, footnotes, strikethrough and task lists. Off until M4: GitHub alerts, math and wikilinks
/// (`[!NOTE]`, `$x$` and `[[w]]` stay literal text), and pulldown-cmark's metadata blocks, which it accepts at any block
/// start: `front_matter_end` finds Z44's at the file's start.
const OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS);

/// Spec §4.1: the format is the file's extension's. `md` and `markdown` are Markdown, in any case.
pub fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// Why a block shows as a note, with "Show in Raw at line N", instead of its HTML (brief §5.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    /// Over 64 KiB of source (`PIECE_BYTES`).
    Big,
    /// Nested deeper than `MAX_DEPTH`.
    Deep,
    /// Its HTML passes `HTML_MAX`, or its text 64 Ki UTF-16 units.
    Large,
}

impl Note {
    pub fn text(self) -> &'static str {
        match self {
            Note::Big => "This block is over 64 KiB",
            Note::Deep => "This block is nested over 64 levels deep",
            Note::Large => "This block renders too large",
        }
    }
}

/// One top-level block (or the front matter).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    /// The block's first line, from 0, and how many lines it runs over (trailing blank lines aside), as Raw numbers
    /// them. A file within `MAX_SOURCE` has fewer than 2^32 lines.
    pub line: u32,
    pub lines: u32,
    /// Sanitized; empty for a note.
    pub html: Box<str>,
    /// A top-level heading's slug: GitHub's algorithm, unique across the file.
    pub slug: Option<Box<str>>,
    /// A footnote definition's label.
    pub footnote: Option<Box<str>>,
    pub note: Option<Note>,
}

/// A file's items, and what they charge.
#[derive(Debug)]
pub struct Rendered {
    items: Vec<Item>,
    units: u64,
    html_bytes: u64,
    nodes: u64,
    note_units: u64,
    /// Pays for the items and this struct. Declared last, so it's released after them.
    charge: Reservation,
}

/// `Rendered` and its holder's share (the napi `Doc`'s `Arc` and `Mutex`).
const RENDERED_BYTES: u64 = size_of::<Rendered>() as u64 + 64;
/// What an item charges until the build ends: 4 slots, since a `Vec` holds its old buffer and a new one twice its size
/// while it grows (and its first holds 4). Then the vector shrinks to fit and its charge to one slot an item.
const ITEM_SLOTS: u64 = 4 * size_of::<Item>() as u64;

impl Rendered {
    fn new() -> Result<Rendered, OverBudget> {
        Ok(Rendered {
            items: Vec::new(),
            units: 0,
            html_bytes: 0,
            nodes: 0,
            note_units: 0,
            charge: Reservation::new(RENDERED_BYTES)?,
        })
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    /// The UTF-16 units of the sanitized HTML's text. Generated note labels are counted separately.
    pub fn units(&self) -> u64 {
        self.units
    }

    pub fn html_bytes(&self) -> u64 {
        self.html_bytes
    }

    /// Element and text nodes, including each block's renderer wrapper and generated note controls.
    pub fn nodes(&self) -> u64 {
        self.nodes
    }

    /// UTF-16 units of generated note labels, including their source-line numbers.
    pub fn note_units(&self) -> u64 {
        self.note_units
    }

    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }

    /// Up to `count` items from `start`, within spec §3.4's bounds: at most `MAX_ITEMS` items and `PAGE_BYTES` of HTML.
    /// The first item always fits. Past the end, none.
    pub fn page(&self, start: usize, count: usize) -> &[Item] {
        let rest = self.items.get(start..).unwrap_or_default();
        let (mut n, mut bytes) = (0, 0);
        for item in rest.iter().take(count.min(MAX_ITEMS)) {
            if n > 0 && bytes + item.html.len() > PAGE_BYTES {
                break;
            }
            bytes += item.html.len();
            n += 1;
        }
        &rest[..n]
    }

    /// Charges `item` (`ITEM_SLOTS` and its heap), then keeps it. Refused, nothing changes.
    fn push(&mut self, item: Item, units: u64) -> Result<(), OverBudget> {
        let heap =
            item.html.len() + item.slug.as_ref().map_or(0, |s| s.len()) + item.footnote.as_ref().map_or(0, |s| s.len());
        self.charge.grow(ITEM_SLOTS + heap as u64)?;
        self.units += units;
        self.html_bytes += item.html.len() as u64;
        if let Some(note) = item.note {
            self.nodes += 3; // the block wrapper, button and its text node
            self.note_units += note.text().encode_utf16().count() as u64
                + " · Show in Raw at line ".encode_utf16().count() as u64
                + (u64::from(item.line) + 1).ilog10() as u64
                + 1;
        } else {
            self.nodes += 1 + html_nodes(&item.html); // the block wrapper and the final serialized fragment
        }
        self.items.push(item);
        Ok(())
    }

    /// The build is done: the vector shrinks to fit, and its charge to what it holds.
    fn finish(mut self) -> Rendered {
        let charged = ITEM_SLOTS * self.items.len() as u64;
        self.items.shrink_to_fit();
        self.charge.shrink(charged.saturating_sub((self.items.capacity() * size_of::<Item>()) as u64));
        self
    }
}

/// The source bytes `text` decoded from: exact for valid UTF-8, UTF-16 and single-byte text, and never less for a
/// U+FFFD (3 in UTF-8, 2 in UTF-16).
fn source_len(text: &str, encoding: &'static Encoding) -> usize {
    if encoding == UTF_8 {
        text.len()
    } else if encoding == UTF_16LE || encoding == UTF_16BE {
        2 * text.encode_utf16().count()
    } else {
        text.chars().count()
    }
}

/// Plan C1: the read's own temporaries, reserved before it: the file's bytes, its decode (`max_utf8_buffer_length`,
/// `None` past `usize`), a chunk read on its way into the cache, and the identity check's copies of the path.
fn read_temp(len: u64, decoded: Option<usize>) -> u64 {
    let decoded = decoded.map_or(u64::MAX / 2, |d| d as u64);
    len + decoded + (CHUNK + 16 * MAX_PATH_BYTES + (64 << 10)) as u64
}

/// pulldown-cmark's tree is a `Vec` of 48-byte nodes that doubles as it grows, so it peaks at 144 bytes a node, its old
/// and new buffers at its last move. Measured on 0.13.4 (scratch probe, 1 MiB of each shape): at most a node per byte of
/// text outside tables, 144 bytes a byte at worst (`*_`, `[]`, `a\n` just past a power of two), 18 on prose, plus at most
/// 23 of other allocations (an autolink's own target). A node bound is charged this much, a third to spare.
const PARSE_PER_NODE: u64 = 192;
/// One block's working memory besides ammonia's: the writer's buffer (`HTML_MAX`); an HTML block's text gathered and
/// escaped, at most 64 KiB of source, 192 KiB decoded, written 4 bytes a byte twice over by `escape_raw`'s replaces; a
/// heading's text and its slug's copies; and the strings pulldown-cmark makes for one block's events.
const BLOCK_TEMP: u64 = 8 << 20;
/// ammonia on one block's HTML (`HTML_MAX`): measured at most 83 bytes a byte (raw `<b>` × 87,381), with output at most
/// 2.4 times its input; then `sanitize`'s rewrite. 128 bytes a byte.
const SANITIZE_TEMP: u64 = 128 * HTML_MAX as u64;

/// Plan C1: the parse's temporaries, reserved before it: pulldown-cmark's tree and allocations for `len` bytes of text
/// with at most `cells` table nodes past one a byte (`table_cells`), one block's buffers, and ammonia's.
fn parse_temp(len: usize, cells: u64) -> u64 {
    PARSE_PER_NODE.saturating_mul((len as u64).saturating_add(cells)).saturating_add(BLOCK_TEMP + SANITIZE_TEMP)
}

/// An upper bound on the table nodes pulldown-cmark 0.13.4 makes past one a byte. It pads each short row with empty
/// cells up to its table's columns: at most 2^18 a table, but nothing bounds them per file, and 1 MiB of 362-column
/// tables with one-cell rows took 9,216 bytes of tree a byte. So each line that could be a delimiter row (after
/// container markers, only ` :-|`, with a `|` and a `-`) counts its header twice over (a paragraph's line, then cells),
/// and every line after it up to the next blank one counts as a row of as many cells as the most `|` + 1 seen since.
/// A blank line is spaces and tabs only, as CommonMark's is.
fn table_cells(text: &str) -> u64 {
    let (mut total, mut cols) = (0u64, 0u64);
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.bytes().all(|b| b == b' ' || b == b'\t') {
            cols = 0;
            continue;
        }
        if cols > 0 {
            total += cols + 1; // the row, and its cells
        }
        let bare = line.trim_start_matches([' ', '\t', '>']).trim_end_matches([' ', '\t']);
        if bare.contains('|') && bare.contains('-') && bare.bytes().all(|b| b" :-|".contains(&b)) {
            let c = bare.bytes().filter(|&b| b == b'|').count() as u64 + 1;
            total += 2 * (c + 1);
            cols = cols.max(c);
        }
    }
    total
}

/// Decodes the file's `bytes` as Raw does (`encoding::decode`'s text, without its map, which would cost up to 13 bytes
/// a byte): its BOM removed, each malformed sequence a U+FFFD. Valid UTF-8 keeps its buffer. Otherwise the decode takes
/// `decoded` bytes (`max_utf8_buffer_length`), once, and never grows.
fn decode(bytes: Vec<u8>, encoding: &'static Encoding, decoded: usize) -> String {
    let bytes = if encoding == UTF_8 {
        match String::from_utf8(bytes) {
            Ok(mut text) => {
                if text.starts_with('\u{FEFF}') {
                    text.drain(..3);
                }
                return text;
            }
            Err(e) => e.into_bytes(),
        }
    } else {
        bytes
    };
    let mut text = String::with_capacity(decoded);
    let (result, _, _) = encoding.new_decoder_with_bom_removal().decode_to_string(&bytes, &mut text, true);
    debug_assert_eq!(result, encoding_rs::CoderResult::InputEmpty, "max_utf8_buffer_length holds any decode");
    text
}

/// A lone CR becomes LF: CommonMark ends a line at either, but pulldown-cmark 0.13.4 misreads a fence opener, front
/// matter or a final line ended by a lone CR (Spike C). Both are one byte, so no offset moves.
/// ponytail: Raw's lines break at LF only, so in a file with lone CRs an item's `line` runs ahead of Raw's. Keep the
/// converted offsets if classic-Mac files matter.
fn lone_cr_to_lf(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    let mut b = text.into_bytes();
    for i in 0..b.len() {
        if b[i] == b'\r' && b.get(i + 1) != Some(&b'\n') {
            b[i] = b'\n';
        }
    }
    String::from_utf8(b).expect("swapping one ASCII byte for another keeps UTF-8 valid")
}

/// Z44: the end of the front matter that opens `text` (the decoded file; its BOM, `bom` source bytes, removed), if it
/// closes within the file's first 64 KiB. pulldown-cmark 0.13.4's metadata-block rule, as Spike C ported it: a `---`
/// line, a first line that is neither blank nor a closer, then a `---` or `...` line (trailing spaces allowed).
fn front_matter_end(text: &str, encoding: &'static Encoding, bom: usize) -> Option<usize> {
    fn bare(l: &str) -> &str {
        l.trim_end_matches(['\n', '\r'])
    }
    let closes = |l: &str| matches!(bare(l).trim_end_matches(' '), "---" | "...");
    let mut lines = text.split_inclusive('\n');
    let (open, first) = (lines.next()?, lines.next()?);
    let blank = bare(first).trim_matches([' ', '\t', '\u{b}', '\u{c}']).is_empty();
    if bare(open).trim_end_matches(|c: char| c.is_ascii_whitespace()) != "---" || blank || closes(first) {
        return None;
    }
    let mut end = open.len() + first.len();
    let mut source = bom + source_len(&text[..end], encoding);
    for l in lines {
        if source > FRONT_MATTER {
            return None;
        }
        end += l.len();
        source += source_len(l, encoding);
        if closes(l) {
            return (source <= FRONT_MATTER).then_some(end);
        }
    }
    None
}

/// The UTF-16 units of the text in sanitized HTML, as the renderer will hold it: an entity is one.
fn text_units(html: &str) -> u64 {
    let (mut units, mut tag, mut entity) = (0u64, false, false);
    for c in html.chars() {
        match c {
            '<' => tag = true,
            '>' if tag => tag = false,
            _ if tag => {}
            ';' if entity => entity = false,
            _ if entity => {}
            '&' => {
                entity = true;
                units += 1;
            }
            c => units += c.len_utf16() as u64,
        }
    }
    units
}

/// Element and text nodes in final fixed-point sanitized HTML. As in `sanitize`'s serialization walk, literal `<`
/// opens a tag and attribute values escape `<` and `>`. Adjacent serialized text stays one text node, entities
/// included; a closing tag is not a second element.
fn html_nodes(mut html: &str) -> u64 {
    let mut nodes = 0;
    while let Some(start) = html.find('<') {
        if start > 0 {
            nodes += 1;
        }
        html = &html[start + 1..];
        if !html.starts_with('/') {
            nodes += 1;
        }
        match html.find('>') {
            Some(end) => html = &html[end + 1..],
            None => return nodes + 1, // conservatively include any unterminated tail as text
        }
    }
    nodes + u64::from(!html.is_empty())
}

/// A hash map's charge for one more entry of `(K, V)`, its key's heap aside: hashbrown doubles its buckets (of the
/// entry's size and a control byte) as it grows, holding the old ones and the new while it moves, at most 4 buckets an
/// entry then (its first table has 4 for 3), plus each table's control group and alignment.
const fn map_entry<K, V>() -> u64 {
    (4 * (size_of::<(K, V)>() + 1) + 32) as u64
}

/// What the build keeps across blocks, besides the items.
struct Build<'c> {
    events: usize,
    cancelled: &'c dyn Fn() -> bool,
    /// Each footnote label's number, in order of first appearance, reference or definition (pulldown-cmark's rule).
    numbers: HashMap<String, u32>,
    /// Each slug taken, and for a slug repeated, its last suffix.
    slugs: HashMap<String, u32>,
    /// Pays for the two maps, as each grows. Declared last, so it's released after them.
    charge: Reservation,
}

impl Build<'_> {
    fn number(&mut self, label: &str) -> Result<u32, OverBudget> {
        if let Some(&n) = self.numbers.get(label) {
            return Ok(n);
        }
        self.charge.grow(map_entry::<String, u32>() + label.len() as u64)?;
        let n = self.numbers.len() as u32 + 1;
        self.numbers.insert(label.to_owned(), n);
        Ok(n)
    }

    /// GitHub's heading slug (github-slugger), Spike C's port: lowercase; keep letters, numbers, `-`, `_` and spaces;
    /// spaces become `-`; a repeat gets `-1`, `-2`, …, skipping any slug already taken.
    /// ponytail: `char::is_alphanumeric` stands in for github-slugger's regex, which also keeps combining marks.
    fn slug(&mut self, text: &str) -> Result<Box<str>, OverBudget> {
        let base: String = text
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
            .map(|c| if c == ' ' { '-' } else { c })
            .collect();
        let mut slug = base.clone();
        while self.slugs.contains_key(&slug) {
            // The first time round, `slug` is `base`; a suffix only ever follows a taken base.
            let n = self.slugs.get_mut(&base).expect("a repeated slug's base is taken");
            *n += 1;
            slug = format!("{base}-{n}");
        }
        self.charge.grow(map_entry::<String, u32>() + slug.len() as u64)?;
        self.slugs.insert(slug.clone(), 0);
        Ok(slug.into_boxed_str())
    }
}

/// One top-level block's events, rewritten for pulldown-cmark's HTML writer:
/// - an HTML block's text, gathered whole, and inline HTML go through `escape_raw`;
/// - a link becomes `<a data-href>`, which `sanitize` judges, and keeps pulldown-cmark's `</a>`;
/// - a footnote reference and definition take the file's numbering (each block has a writer of its own);
/// - an image's alt text passes as it is: the writer escapes all of it into `alt`.
///
/// It stops early (`None`) on a cancel, a refused charge (`stop`), or nesting past `MAX_DEPTH` (`deep`).
struct Events<'p, 'b, 'a, I> {
    parser: &'p mut I,
    build: &'p mut Build<'b>,
    first: Option<Event<'a>>,
    pending: Option<Event<'a>>,
    depth: usize,
    done: bool,
    deep: bool,
    stop: Option<DocError>,
    /// Inside an image's alt text, which ends below this depth.
    alt: Option<usize>,
    /// An HTML block's text so far.
    raw: Option<String>,
    /// A top-level heading's text, for its slug.
    heading: Option<String>,
}

impl<'a, I: Iterator<Item = (Event<'a>, Range<usize>)>> Events<'_, '_, 'a, I> {
    /// Counts `event`, checks the cancel flag every `CANCEL_EVERY` events, and follows the block's depth.
    fn step(&mut self, event: &Event) -> Result<(), DocError> {
        self.build.events += 1;
        if self.build.events.is_multiple_of(CANCEL_EVERY) && (self.build.cancelled)() {
            return Err(DocError::Cancelled);
        }
        match event {
            Event::Start(_) => self.depth += 1,
            Event::End(_) => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }
        self.done = self.depth == 0;
        Ok(())
    }

    /// Reads the rest of the block, writing nothing.
    fn drain(&mut self) -> Result<(), DocError> {
        if let Some(e) = self.stop.take() {
            return Err(e);
        }
        while !self.done {
            let Some(event) = self.first.take().or_else(|| self.parser.next().map(|(e, _)| e)) else { break };
            self.step(&event)?;
        }
        Ok(())
    }

    fn rewrite(&mut self, event: Event<'a>) -> Result<Event<'a>, DocError> {
        match &event {
            Event::Start(Tag::HtmlBlock) => self.raw = Some(String::new()),
            Event::Start(Tag::Image { .. }) => self.alt = Some(self.depth),
            Event::Start(Tag::Heading { .. }) if self.depth == 1 => self.heading = Some(String::new()),
            Event::Text(t) | Event::Code(t) => {
                if let Some(h) = self.heading.as_mut() {
                    h.push_str(t);
                }
            }
            _ => {}
        }
        let escaped = |t: &str| {
            let mut out = String::new();
            escape_raw(t, &mut out);
            out
        };
        Ok(match event {
            Event::Start(Tag::Link { link_type, dest_url, .. }) => {
                let url =
                    if link_type == LinkType::Email { format!("mailto:{dest_url}") } else { dest_url.to_string() };
                Event::InlineHtml(format!("<a data-href=\"{}\">", escape_attr(&url)).into())
            }
            Event::FootnoteReference(label) => {
                let n = self.build.number(&label).map_err(DocError::Memory)?;
                Event::InlineHtml(format!("<sup><a data-href=\"#{}\">{n}</a></sup>", escape_attr(&label)).into())
            }
            Event::Start(Tag::FootnoteDefinition(label)) => {
                let n = self.build.number(&label).map_err(DocError::Memory)?;
                Event::Html(format!("<div><sup>{n}</sup>").into()) // pulldown-cmark's end writes `</div>`
            }
            Event::Html(t) => Event::Html(escaped(&t).into()),
            Event::InlineHtml(t) => Event::InlineHtml(escaped(&t).into()),
            e => e,
        })
    }
}

impl<'a, I: Iterator<Item = (Event<'a>, Range<usize>)>> Iterator for Events<'_, '_, 'a, I> {
    type Item = Event<'a>;

    fn next(&mut self) -> Option<Event<'a>> {
        loop {
            if let Some(e) = self.pending.take() {
                return Some(e);
            }
            if self.done || self.deep || self.stop.is_some() {
                return None;
            }
            let event = self.first.take().or_else(|| self.parser.next().map(|(e, _)| e))?;
            if let Err(e) = self.step(&event) {
                self.stop = Some(e);
                return None;
            }
            if self.depth > MAX_DEPTH {
                self.deep = true;
                return None;
            }
            if let Some(level) = self.alt {
                if self.depth < level {
                    self.alt = None;
                }
                return Some(event);
            }
            if let Some(raw) = self.raw.as_mut() {
                match &event {
                    Event::Html(t) | Event::Text(t) => {
                        raw.push_str(t);
                        continue;
                    }
                    Event::End(TagEnd::HtmlBlock) => {
                        let mut html = String::new();
                        escape_raw(&self.raw.take().unwrap_or_default(), &mut html);
                        self.pending = Some(event);
                        return Some(Event::Html(html.into()));
                    }
                    _ => {}
                }
            }
            match self.rewrite(event) {
                Ok(e) => return Some(e),
                Err(e) => {
                    self.stop = Some(e);
                    return None;
                }
            }
        }
    }
}

/// The writer's buffer, which refuses any write past `HTML_MAX`: the block is then a note. It's sized once, so it
/// never grows.
struct Capped<'s>(&'s mut String);

impl fmt::Write for Capped<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.0.len() + s.len() > HTML_MAX {
            return Err(fmt::Error);
        }
        self.0.push_str(s);
        Ok(())
    }
}

/// `sanitize` until a pass changes nothing, each on at most `HTML_MAX`: ammonia repairs some mis-nesting (an `<a>`
/// inside an `<a>`, by way of a table) into HTML that parses differently again, which the next pass settles. None when
/// it's too large, or still changing after 3 passes.
fn clean(written: &str) -> Option<String> {
    let mut html = sanitize(written);
    for _ in 0..3 {
        if html.len() > HTML_MAX {
            return None;
        }
        let again = sanitize(&html);
        if again == html {
            return Some(html);
        }
        html = again;
    }
    None
}

/// Where each block starts, as Raw numbers lines: a cursor, since blocks come in order.
#[derive(Default)]
struct Lines {
    at: usize,
    line: usize,
}

impl Lines {
    /// `span`'s first line, and how many lines its text runs over, trailing blank lines aside.
    fn of(&mut self, text: &str, span: Range<usize>) -> (u32, u32) {
        if span.start < self.at {
            *self = Lines::default(); // never for top-level blocks, which come in order
        }
        self.line += memchr::memchr_iter(b'\n', &text.as_bytes()[self.at..span.start]).count();
        self.at = span.start;
        let body = text[span].trim_end_matches([' ', '\t', '\r', '\n']);
        (self.line as u32, 1 + memchr::memchr_iter(b'\n', body.as_bytes()).count() as u32)
    }
}

/// The items of `text`, the decoded file whose first `front` bytes are its front matter (plan §2.1). `cancelled` is
/// checked every `CANCEL_EVERY` events.
fn blocks(
    text: &str,
    front: usize,
    encoding: &'static Encoding,
    cancelled: &dyn Fn() -> bool,
) -> Result<Rendered, DocError> {
    let mut out = Rendered::new().map_err(DocError::Memory)?;
    let mut build =
        Build { events: 0, cancelled, numbers: HashMap::new(), slugs: HashMap::new(), charge: Reservation::none() };
    let mut lines = Lines::default();
    let mut buf = String::with_capacity(HTML_MAX);
    // One item, from what its block wrote or the note it became.
    type Label = Option<Box<str>>;
    let mut item =
        |out: &mut Rendered, span: Range<usize>, written: Result<&str, Note>, slug: Label, footnote: Label| {
            let (line, lines) = lines.of(text, span);
            let (html, units, note) = match written.and_then(|w| clean(w).ok_or(Note::Large)) {
                Ok(html) => match text_units(&html) {
                    units if units <= PIECE_BYTES as u64 => (html.into_boxed_str(), units, None),
                    _ => (Box::default(), 0, Some(Note::Large)),
                },
                Err(note) => (Box::default(), 0, Some(note)),
            };
            let slug = if note.is_none() { slug } else { None };
            out.push(Item { line, lines, html, slug, footnote, note }, units).map_err(DocError::Memory)
        };
    if front > 0 {
        let mut code = String::from("<pre><code>");
        escape_text(&text[..front], &mut code);
        code.push_str("</code></pre>");
        let written = if code.len() <= HTML_MAX { Ok(code.as_str()) } else { Err(Note::Large) };
        item(&mut out, 0..front, written, None, None)?;
    }
    let mut parser = Parser::new_ext(&text[front..], OPTIONS).into_offset_iter();
    while let Some((first, r)) = parser.next() {
        let span = front + r.start..front + r.end;
        let footnote = match &first {
            Event::Start(Tag::FootnoteDefinition(label)) => Some(Box::from(&**label)),
            _ => None,
        };
        let mut events = Events {
            parser: &mut parser,
            build: &mut build,
            first: Some(first),
            pending: None,
            depth: 0,
            done: false,
            deep: false,
            stop: None,
            alt: None,
            raw: None,
            heading: None,
        };
        buf.clear();
        let written = if source_len(&text[span.clone()], encoding) > PIECE_BYTES {
            Err(Note::Big)
        } else {
            let wrote = html::write_html_fmt(Capped(&mut buf), &mut events);
            if events.deep {
                Err(Note::Deep)
            } else if wrote.is_err() && events.stop.is_none() {
                Err(Note::Large)
            } else {
                Ok(()) // or stopped, which `drain` returns
            }
        };
        events.drain()?;
        let heading = events.heading.take();
        let slug = match (&heading, &written) {
            (Some(text), Ok(())) => Some(build.slug(text).map_err(DocError::Memory)?),
            _ => None,
        };
        item(&mut out, span, written.map(|()| buf.as_str()), slug, footnote)?;
    }
    Ok(out.finish())
}

/// The whole file of generation `generation` as items, from one verified read (plan §2.1). `encoding` is Raw's.
/// `cancelled` is checked every `CANCEL_EVERY` events; the read checks the store's own flag (`store::cancellable`).
/// pulldown-cmark's first pass, which builds the whole file's block tree before the first event, can't be cancelled.
/// - Over `MAX_SOURCE`: `Refused`, with the reason.
/// - A stale generation is `Stale`, a frozen document `Frozen`, before anything is read.
/// - Plan C1: the read and decode are reserved first, then the parse's temporaries (`parse_temp`), and the items as
///   they're made. A refusal is `Memory`, with nothing left charged.
pub fn build(
    doc: &Document,
    encoding: &'static Encoding,
    generation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<Rendered, DocError> {
    let len = doc.len();
    if len > MAX_SOURCE {
        let why = format!("over 8 MiB ({len} bytes): Rendered shows files of up to {MAX_SOURCE} bytes");
        return Err(DocError::Refused(why));
    }
    let decoded = encoding.new_decoder_with_bom_removal().max_utf8_buffer_length(len as usize);
    let mut temp = Reservation::new(read_temp(len, decoded)).map_err(DocError::Memory)?; // released last
    let bytes = doc.verified(generation, |store| store.read(0, len))?;
    let bom = match Encoding::for_bom(&bytes) {
        Some((e, n)) if e == encoding => n,
        _ => 0,
    };
    let text = lone_cr_to_lf(decode(bytes, encoding, decoded.unwrap_or(0)));
    temp.shrink(temp.bytes() - text.capacity() as u64); // the bytes, or the decode, are all that's left
    if cancelled() {
        return Err(DocError::Cancelled);
    }
    let front = front_matter_end(&text, encoding, bom).unwrap_or(0);
    temp.grow(parse_temp(text.len(), table_cells(&text[front..]))).map_err(DocError::Memory)?;
    blocks(&text, front, encoding, cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raw::Raw;
    use crate::store::{cancellable, testutil::temp_file};
    use proptest::prelude::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    /// `md` as the items of a UTF-8 file with that text.
    fn render(md: &str) -> Rendered {
        let text = lone_cr_to_lf(md.to_owned());
        let front = front_matter_end(&text, UTF_8, 0).unwrap_or(0);
        blocks(&text, front, UTF_8, &|| false).unwrap()
    }

    fn htmls(md: &str) -> Vec<String> {
        render(md).items().iter().map(|i| i.html.to_string()).collect()
    }

    /// `bytes` as a file, opened in Raw and rendered.
    fn render_file(name: &str, bytes: &[u8]) -> Result<Rendered, DocError> {
        Raw::open(&temp_file(name, bytes)).unwrap().render(1)
    }

    /// Plan §1's In constructs, each to its sanitized HTML: what pulldown-cmark writes, less what ammonia strips (a
    /// code block's language class, a cell's alignment style, a link's title), with every link and image rewritten.
    #[test]
    fn each_in_construct_renders_to_its_sanitized_html() {
        let cases: [(&str, &[&str]); 21] = [
            ("# One\n\nTwo\n===\n", &["<h1>One</h1>\n", "<h1>Two</h1>\n"]),
            (
                "*a* **b** ~~c~~ `d` _e_",
                &["<p><em>a</em> <strong>b</strong> <del>c</del> <code>d</code> <em>e</em></p>\n"],
            ),
            ("- a\n- b\n", &["<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n"]),
            ("3. a\n4. b\n", &["<ol start=\"3\">\n<li>a</li>\n<li>b</li>\n</ol>\n"]),
            (
                "- [ ] a\n- [x] b\n",
                &[
                    "<ul>\n<li><input disabled=\"\" type=\"checkbox\">\na</li>\n<li><input disabled=\"\" type=\"checkbox\" checked=\"\">\nb</li>\n</ul>\n",
                ],
            ),
            ("> q\n> > r\n", &["<blockquote>\n<p>q</p>\n<blockquote>\n<p>r</p>\n</blockquote>\n</blockquote>\n"]),
            ("```rust\nfn x() {} // <b>\n```\n", &["<pre><code>fn x() {} // &lt;b&gt;\n</code></pre>\n"]),
            ("    indented\n", &["<pre><code>indented\n</code></pre>\n"]),
            (
                "| a | b |\n|:--|--:|\n| 1 | x<br>y |\n",
                &[
                    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n<tr><td>1</td><td>x<br>y</td></tr>\n</tbody></table>\n",
                ],
            ),
            (
                "x[^n] y[^m]\n\n[^m]: M\n\n[^n]: N\n",
                &[
                    "<p>x<sup><a href=\"#\" data-href=\"#n\">1</a></sup> y<sup><a href=\"#\" data-href=\"#m\">2</a></sup></p>\n",
                    "<div><sup>2</sup>\n<p>M</p>\n</div>\n",
                    "<div><sup>1</sup>\n<p>N</p>\n</div>\n",
                ],
            ),
            (
                "<details><summary>S</summary>body <kbd>K</kbd></details>\n",
                &["<details><summary>S</summary>body <kbd>K</kbd></details>\n"],
            ),
            ("a <sub>1</sub><sup>2</sup> <i>i</i><b>b</b>", &["<p>a <sub>1</sub><sup>2</sup> <i>i</i><b>b</b></p>\n"]),
            (
                "[t](https://x.y \"T\") [r]\n\n[r]: /rel",
                &["<p><a href=\"#\" data-href=\"https://x.y\">t</a> <a href=\"#\" data-href=\"/rel\">r</a></p>\n"],
            ),
            (
                "<https://a.b> <me@x.y>",
                &[
                    "<p><a href=\"#\" data-href=\"https://a.b\">https://a.b</a> <a href=\"#\" data-href=\"mailto:me@x.y\">me@x.y</a></p>\n",
                ],
            ),
            ("[#](#one)", &["<p><a href=\"#\" data-href=\"#one\">#</a></p>\n"]),
            (
                "![alt *b*](a.png \"t\")",
                &["<p><span class=\"tp-img\" data-src=\"a.png\" data-alt=\"alt b\"></span></p>\n"],
            ),
            (
                "[![i](i.png)](o.md)",
                &[
                    "<p><a href=\"#\" data-href=\"o.md\"><span class=\"tp-img\" data-src=\"i.png\" data-alt=\"i\"></span></a></p>\n",
                ],
            ),
            ("a\n\n---\n", &["<p>a</p>\n", "<hr>\n"]),
            ("a  \nb\\\nc", &["<p>a<br>\nb<br>\nc</p>\n"]),
            ("&copy; &amp; &lt; &#x1F600; \\*", &["<p>© &amp; &lt; 😀 *</p>\n"]),
            ("see https://example.com", &["<p>see https://example.com</p>\n"]), // GFM's bare autolinks aren't parsed
        ];
        for (md, want) in cases {
            assert_eq!(htmls(md), want, "{md:?}");
        }
        let notes = render("x[^n]\n\n[^n]: N\n");
        assert_eq!(notes.items()[1].footnote.as_deref(), Some("n"));
    }

    #[test]
    fn top_level_headings_get_githubs_unique_slugs() {
        let r = render(
            "# Hello, World!\n\n## Hello World\n\n- # nested\n\n# hello-world-1\n\n# `Code` *and* [link](x)\n\n#\n\n#\n",
        );
        let slugs: Vec<_> = r.items().iter().map(|i| i.slug.as_deref()).collect();
        let want = [
            Some("hello-world"),
            Some("hello-world-1"),
            None,
            Some("hello-world-1-1"),
            Some("code-and-link"),
            Some(""),
            Some("-1"),
        ];
        assert_eq!(slugs, want);
    }

    /// Plan §1: a GitHub alert, math and a wikilink stay literal text until M4.
    #[test]
    fn alerts_math_and_wikilinks_stay_literal() {
        assert_eq!(
            htmls("> [!NOTE]\n> $x$ and $$y$$ [[w]] [[w|t]]"),
            ["<blockquote>\n<p>[!NOTE]\n$x$ and $$y$$ [[w]] [[w|t]]</p>\n</blockquote>\n"]
        );
    }

    /// Z44: front matter at the file's start shows as a code block, never discarded; anywhere else, or closing past the
    /// first 64 KiB, it's ordinary Markdown.
    #[test]
    fn front_matter_shows_only_at_the_start_and_within_64_kib() {
        let r = render("---\ntitle: <x>\n---\nbody\n");
        let got: Vec<_> = r.items().iter().map(|i| (i.line, i.lines, &*i.html)).collect();
        assert_eq!(got, [(0, 3, "<pre><code>---\ntitle: &lt;x&gt;\n---\n</code></pre>"), (3, 1, "<p>body</p>\n")]);
        assert_eq!(htmls("intro\n\n---\ntitle: x\n---\n"), ["<p>intro</p>\n", "<hr>\n", "<h2>title: x</h2>\n"]);
        assert_eq!(htmls("\n---\ntitle: x\n---\n"), ["<hr>\n", "<h2>title: x</h2>\n"]); // not at offset 0
        // Closing within the first 64 KiB, at 65,536 exactly, and one byte past it.
        let at = |end: usize| format!("---\n{}\n---\nbody\n", "k".repeat(end - 9));
        assert_eq!(at(FRONT_MATTER).find("\n---\n").unwrap() + 5, FRONT_MATTER);
        assert!(htmls(&at(FRONT_MATTER))[0].starts_with("<pre><code>---\nkkk"));
        let over = htmls(&at(FRONT_MATTER + 1));
        assert_eq!(&over[..1], ["<hr>\n"]);
        assert!(over[1].starts_with("<h2>kkk")); // never discarded
        // After a BOM, from a file; and its source bytes counted in UTF-16.
        let r = render_file("md-fm-bom", "\u{FEFF}---\na: 1\n...\n# H\n".as_bytes()).unwrap();
        assert_eq!(r.items()[0].html.as_ref(), "<pre><code>---\na: 1\n...\n</code></pre>");
        let utf16 =
            |s: &str| [&[0xFF, 0xFE][..], &s.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>()].concat();
        let fits = format!("---\n{}\n---\n", "k".repeat(FRONT_MATTER / 2 - 10)); // 65,534 bytes after the BOM
        assert!(render_file("md-fm-u16", &utf16(&fits)).unwrap().items()[0].html.starts_with("<pre><code>"));
        let over = format!("---\n{}\n---\n", "k".repeat(FRONT_MATTER / 2 - 9));
        assert_eq!(render_file("md-fm-u16-over", &utf16(&over)).unwrap().items()[0].html.as_ref(), "<hr>\n");
    }

    /// Items carry Raw's line numbers: CRLF, a BOM, UTF-16 and windows-1252 alike, trailing blank lines aside.
    #[test]
    fn items_carry_raws_line_numbers() {
        let md = "a\r\nb\r\n\r\n- c\r\n  d\r\n\r\n\r\n```\r\nx\r\n```\r\n# h\r\n";
        let want = [(0, 2), (3, 2), (7, 3), (10, 1)];
        let lines = |r: Rendered| r.items().iter().map(|i| (i.line, i.lines)).collect::<Vec<_>>();
        assert_eq!(lines(render(md)), want);
        assert_eq!(lines(render_file("md-lines-bom", &[b"\xEF\xBB\xBF", md.as_bytes()].concat()).unwrap()), want);
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(md.encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert_eq!(lines(render_file("md-lines-u16", &utf16).unwrap()), want);
        let w1252 = render_file("md-lines-1252", &[md.as_bytes(), b"caf\xE9\n"].concat()).unwrap();
        assert_eq!(w1252.items().last().unwrap().html.as_ref(), "<p>café</p>\n");
    }

    /// Plan §3's bounds: a block over 64 KiB of source, nested over 64 deep or writing over 256 KiB is a note at its line.
    #[test]
    fn oversized_blocks_are_notes() {
        let kib65 = 65 << 10;
        let para = "word ".repeat(kib65 / 5);
        let row = "| a | b |\n";
        let table = format!("| h | i |\n|---|---|\n{}", row.repeat(kib65 / row.len()));
        let fence = format!("```\n{}```\n", "code line\n".repeat(kib65 / 10));
        for (name, block) in [("paragraph", &para), ("table", &table), ("fence", &fence)] {
            let r = render(&format!("intro\n\n{block}\n\nafter\n"));
            let notes: Vec<_> = r.items().iter().map(|i| (i.line, i.note, i.html.is_empty())).collect();
            assert_eq!(notes[1], (2, Some(Note::Big), true), "{name}");
            assert_eq!((notes.len(), r.items()[2].html.as_ref()), (3, "<p>after</p>\n"), "{name}");
        }
        // 64 quotes around a paragraph nest it 65 deep; 63 render.
        assert_eq!(render(&format!("{} x", ">".repeat(64))).items()[0].note, Some(Note::Deep));
        assert!(render(&format!("{} x", ">".repeat(63))).items()[0].html.ends_with("</blockquote>\n"));
        // Under 64 KiB of source, but over 256 KiB of HTML: as written, and once sanitized (a raw cell's tables).
        assert_eq!(render(&("[^a]".repeat(15_000) + "\n\n[^a]: x\n")).items()[0].note, Some(Note::Large));
        let nested = format!("<table><td>{}\n", "<table><td>".repeat(5_800));
        assert!(nested.len() < 64 << 10);
        assert_eq!(render(&nested).items()[0].note, Some(Note::Large));
        assert_eq!(Note::Big.text(), "This block is over 64 KiB");
    }

    #[test]
    fn final_html_nodes_include_empty_elements_and_single_entity_text_runs() {
        for (html, nodes) in [
            ("", 0),
            ("a &amp; &#x1F600;", 1),
            ("<h1></h1>\n", 2),
            ("<p>one <em>x</em></p>\n", 5),
            ("<p><span data-alt=\"&lt;&gt; &amp;\"></span></p>\n", 3),
            ("<input disabled=\"\" type=\"checkbox\">\n", 2),
            ("<table><tbody><tr><td></td></tr></tbody></table>\n", 5),
            ("<pre><code>\n&amp;\n</code></pre>\n", 4),
        ] {
            assert_eq!(html_nodes(html), nodes, "{html:?}");
        }
        let html = clean(r#"<a data-href="a<>b">x &amp; y</a>"#).unwrap();
        assert!(html.contains("&lt;&gt;"), "{html}");
        assert_eq!(html_nodes(&html), 2); // one anchor, one text node; attribute entities add no nodes
    }

    #[test]
    fn build_summary_charges_zero_text_blocks_and_the_generated_note_label() {
        let r = render(&format!("{} x\n\n#\n\n* * *\n", ">".repeat(65)));
        assert_eq!(r.items().len(), 3);
        assert_eq!(r.items()[0].note, Some(Note::Deep));
        assert_eq!(r.units(), 2); // the heading's and rule's serialized newlines; the note stays separate
        assert_eq!(r.nodes(), 9); // note wrapper/button/text, then wrapper/heading/newline and wrapper/rule/newline
        let label = format!("{} · Show in Raw at line 1", Note::Deep.text());
        assert_eq!(r.note_units(), label.encode_utf16().count() as u64);

        for note in [Note::Big, Note::Deep, Note::Large] {
            for line in [0, 8, 9, 98, 99, 999, u32::MAX] {
                let mut r = Rendered::new().unwrap();
                r.push(Item { line, lines: 1, html: Box::default(), slug: None, footnote: None, note: Some(note) }, 0)
                    .unwrap();
                let label = format!("{} · Show in Raw at line {}", note.text(), u64::from(line) + 1);
                assert_eq!(r.note_units(), label.encode_utf16().count() as u64);
                assert_eq!((r.units(), r.html_bytes(), r.nodes()), (0, 0, 3));
            }
        }
    }

    /// Plan §3: no item over 64 Ki units of text, and no page over 256 KiB of HTML; the first item always fits.
    #[test]
    fn items_and_pages_hold_their_bounds() {
        let md = format!("{}\n\n", "x".repeat(60_000)).repeat(10) + &"- y\n\n".repeat(3_000);
        let r = render(&md);
        assert!(r.items().iter().all(|i| text_units(&i.html) <= PIECE_BYTES as u64 && i.html.len() <= HTML_MAX));
        assert_eq!(r.units(), r.items().iter().map(|i| text_units(&i.html)).sum());
        let mut start = 0;
        while start < r.items().len() {
            let page = r.page(start, usize::MAX);
            assert!(!page.is_empty() && page.len() <= MAX_ITEMS);
            assert!(page.len() == 1 || page.iter().map(|i| i.html.len()).sum::<usize>() <= PAGE_BYTES);
            start += page.len();
        }
        assert_eq!(r.page(0, 9).len(), 4); // 4 × 60,008 ≤ 256 KiB < 5 × 60,008
        assert_eq!(r.page(r.items().len(), 5), []);
        assert_eq!(r.page(usize::MAX, 5), []);
        assert_eq!(text_units("<p>a &amp; 😀</p>"), 6);
    }

    /// Z71: 8 MiB of source renders; a byte more is refused with the reason, before anything is read.
    #[test]
    fn the_ceiling_is_8_mib() {
        let r = render_file("md-ceiling", &vec![b'x'; MAX_SOURCE as usize]).unwrap();
        assert_eq!(r.items()[0].note, Some(Note::Big));
        match render_file("md-ceiling-over", &vec![b'x'; MAX_SOURCE as usize + 1]) {
            Err(DocError::Refused(why)) => assert!(why.starts_with("over 8 MiB (8388609 bytes)"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    /// Plan §2.1: a cancel ends the build, at the read or within 1,024 events of the parse, and the document reads on.
    #[test]
    fn a_cancel_ends_the_build() {
        let md = "*a* ".repeat(5_000);
        let checks = std::cell::Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() > 2
        };
        assert!(matches!(blocks(&md, 0, UTF_8, &cancelled), Err(DocError::Cancelled)));
        assert_eq!(checks.get(), 3);
        let path = temp_file("md-cancel", md.as_bytes());
        let raw = Raw::open(&path).unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        assert!(matches!(cancellable(&flag, || raw.render(1)), Err(DocError::Cancelled)));
        assert_eq!(raw.document().frozen(), None);
        assert_eq!(raw.render(1).unwrap().items().len(), 1);
    }

    /// A frozen document's build is `Frozen`; an old generation's is `Stale`.
    #[test]
    fn a_frozen_document_or_an_old_generation_is_refused() {
        let path = temp_file("md-gens", b"# a\n");
        let raw = Raw::open(&path).unwrap();
        assert_eq!(raw.render(1).unwrap().items().len(), 1);
        std::fs::write(&path, b"# b\n\nmore\n").unwrap();
        assert!(matches!(raw.render(1), Err(DocError::Frozen(_))));
        let fresh = raw.reload().unwrap();
        assert!(matches!(fresh.render(1), Err(DocError::Stale { current: 2, asked: 1 })));
        assert_eq!(fresh.render(2).unwrap().items().len(), 2);
    }

    #[test]
    fn md_and_markdown_are_markdown() {
        for (name, md) in
            [("a.md", true), ("b.MarkDown", true), ("c.MD", true), ("d.txt", false), ("md", false), ("e.mdx", false)]
        {
            assert_eq!(is_markdown(Path::new(name)), md, "{name}");
        }
    }

    /// The parse's reservation covers pulldown-cmark's padded table cells: for every table shape, the rows and cells it
    /// visits are within `table_cells` plus a node a byte.
    #[test]
    fn table_cells_bounds_the_padded_cells() {
        let shapes = [
            format!("{}\n{}\n{}", "|a".repeat(362), "|-".repeat(362), "a\n".repeat(724)),
            format!("> |a|b|\n> |-|-|\n{}", "> x\n".repeat(50)),
            "- |a|b|c|\n  |-|:-:|-|\n  x\n\n  y\n".to_string(),
            "| a |\n| - |\n|\n|\n".to_string(),
            "a|b\n-|-\nc\n\n|x|\n|-|\n".to_string(),
        ];
        for md in shapes {
            let nodes = Parser::new_ext(&md, OPTIONS)
                .filter(|e| matches!(e, Event::Start(Tag::TableCell | Tag::TableRow | Tag::TableHead)))
                .count() as u64;
            assert!(
                nodes <= table_cells(&md) + md.len() as u64,
                "{nodes} > {} + {}: {md:?}",
                table_cells(&md),
                md.len()
            );
        }
        assert!(table_cells(&format!("{}\n{}\n{}", "|a".repeat(362), "|-".repeat(362), "a\n".repeat(724))) > 262_000);
        assert_eq!(table_cells("p\n\n|-|\nb\nc\n\nd\n"), 8 + 4 + 4); // a delimiter-like line, then two rows
    }

    // ---- The sanitizer, through the whole build (Spike C's gates, `md_gates.rs`) ----

    /// Spike C's output oracle (`md_gates.rs` `check_output`), independent of ammonia's configuration, with this slice's
    /// one change: every link is `<a href="#">`, and no other `href` exists. Only the tags below, and on each only its
    /// attributes: no `on*`, no `style`, no resource-loading attribute, no `link`, `meta`, `base`, `style`, `script`,
    /// `iframe`, `object`, `svg`, `math` or `img` element. A `data-href` is never javascript, vbscript or data; a
    /// `data-src` is http, https or a relative path that isn't a network path. Sanitizing again changes nothing.
    fn check_output(html: &str) -> Result<(), String> {
        const TAGS: &str = "b i em strong code kbd sub sup br hr details summary a table thead tbody tr th td p h1 h2 h3 \
                            h4 h5 h6 blockquote ul ol li pre del span div input";
        const FORBIDDEN: &str = "link meta base style script iframe object svg math img";
        const ATTRS: [(&str, &str); 9] = [
            ("a", "href"),
            ("a", "data-href"),
            ("ol", "start"),
            ("input", "type"),
            ("input", "checked"),
            ("input", "disabled"),
            ("span", "class"),
            ("span", "data-src"),
            ("span", "data-alt"),
        ];
        let listed = |list: &str, name: &str| list.split_whitespace().any(|t| t == name);
        let mut rest = html;
        while let Some(i) = rest.find('<') {
            let end = rest[i..].find('>').ok_or("unterminated tag")? + i;
            let (closing, tag) = match &rest[i + 1..end] {
                t if t.starts_with('/') => (true, &t[1..]),
                t => (false, t),
            };
            rest = &rest[end + 1..];
            let (name, mut attrs) = tag.split_once(' ').unwrap_or((tag, ""));
            if listed(FORBIDDEN, name) || !listed(TAGS, name) {
                return Err(format!("element <{name}>"));
            }
            if name == "a" && !closing && !attrs.starts_with("href=\"#\"") {
                return Err(format!("a link without href=\"#\": <{tag}>"));
            }
            while let Some((attr, after)) = attrs.trim_start().split_once("=\"") {
                let (value, after) = after.split_once('"').ok_or("unquoted attribute")?;
                attrs = after;
                if !ATTRS.contains(&(name, attr)) {
                    return Err(format!("attribute {attr} on <{name}>"));
                }
                let value = value
                    .replace("&quot;", "\"")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&nbsp;", "\u{A0}")
                    .replace("&amp;", "&");
                let (s, scheme) = whatwg(&value);
                let bad = match attr {
                    "href" => value != "#",
                    "data-href" => scheme.is_some_and(|s| matches!(s.as_str(), "javascript" | "vbscript" | "data")),
                    "data-src" => network_path(&s) || scheme.is_some_and(|s| !matches!(s.as_str(), "http" | "https")),
                    "class" => value != "tp-img",
                    _ => false,
                };
                if bad {
                    return Err(format!("{attr} {value:?}"));
                }
            }
            if !attrs.trim().is_empty() {
                return Err(format!("stray attribute text {attrs:?}"));
            }
        }
        if sanitize(html) != html {
            return Err("sanitizing again changed it".into());
        }
        Ok(())
    }

    /// WHATWG URL parsing's first steps: C0 controls and spaces trimmed, tabs and newlines removed. Then the URL and its
    /// scheme, lowercased: an ASCII letter followed by letters, digits, `+`, `-` or `.` before the first `:`.
    fn whatwg(url: &str) -> (String, Option<String>) {
        let s: String =
            url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
        let scheme = s
            .split_once(':')
            .map(|(scheme, _)| scheme)
            .filter(|scheme| {
                scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                    && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
            })
            .map(str::to_ascii_lowercase);
        (s, scheme)
    }

    /// `//host…` or `\\host…` (WHATWG reads `\` as `/`): a UNC path the brief touches only after a click.
    fn network_path(s: &str) -> bool {
        let b = s.as_bytes();
        b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\')
    }

    /// Every item: structurally safe (`check_output`) and within the caps.
    fn check_items(r: &Rendered) -> Result<(), String> {
        for it in r.items() {
            check_output(&it.html)?;
            if text_units(&it.html) > PIECE_BYTES as u64 || it.html.len() > HTML_MAX {
                return Err(format!("item over the caps: {} bytes", it.html.len()));
            }
        }
        Ok(())
    }

    /// Hostile raw HTML and mXSS payloads; `true` where the payload is HTML whose first disallowed tag must show as
    /// literal text (`false` for Markdown-syntax payloads).
    const HOSTILE: [(&str, bool); 71] = [
        // svg/math namespace confusion
        ("<svg><style><img src=x onerror=alert(1)></style></svg>", true),
        ("<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>", true),
        ("<svg><foreignObject><b>x</b></foreignObject></svg>", true),
        ("<math><mi><svg><title><img src=x onerror=1>", true),
        ("<svg><a xlink:href=\"javascript:alert(1)\">x</a></svg>", true),
        ("<math href=\"javascript:alert(1)\">x</math>", true),
        // raw-text and RCDATA elements
        ("<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">", true),
        ("<style><img src=x onerror=1></style>", true),
        ("<template><img src=x onerror=1></template>", true),
        ("<textarea><img src=x onerror=1></textarea>", true),
        ("<title><img src=x onerror=1></title>", true),
        ("<xmp><img src=x onerror=1></xmp>", true),
        ("<plaintext><img src=x onerror=1>", true),
        ("<noembed><img src=x onerror=1></noembed>", true),
        ("<iframe><img src=x onerror=1></iframe>", true),
        // comments and CDATA
        ("<!--<img src=x onerror=1>-->", false),
        ("<!--><img src=x onerror=1>-->", false),
        ("<![CDATA[<img src=x onerror=1>]]>", false),
        ("<!-- unclosed\n\n<img src=x onerror=1>", false),
        ("<!DOCTYPE html><html><body onload=alert(1)>", true),
        ("<?xml version=\"1.0\"?><x onclick=1>", true),
        // unclosed and split tags, across lines, events and blocks
        ("<b title=\"\n\n\" onclick=1>x</b>", false),
        ("<scr\n\nipt>alert(1)</script>", true),
        ("a <b\nonclick=1>x</b>", false),
        ("<b>open in block 1\n\n</b> closed in block 2", false),
        ("<a href=\"javascript:alert(1)\"\n\n>split</a>", false),
        ("<img src=x\n\nonerror=alert(1)>", false),
        // event handlers and URL schemes, with entity, tab, newline and case obfuscation
        ("<img src=x onerror=alert(1)>", false),
        ("<a href=\"javascript:alert(1)\">x</a>", false),
        ("<a href=\"JaVaScRiPt:alert(1)\">x</a>", false),
        ("<a href=\"java&#x09;script:alert(1)\">x</a>", false),
        ("<a href=\"java\tscript:alert(1)\">x</a>", false),
        ("<a href=\"&#106;avascript:alert(1)\">x</a>", false),
        ("<a href=\"&#x6A;avascript&#58;alert(1)\">x</a>", false),
        ("<a href=\" javascript:alert(1)\">x</a>", false),
        ("<a href=\"&#14;javascript:alert(1)\">x</a>", false),
        ("<a href=\"vbscript:msgbox(1)\">x</a>", false),
        ("<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">x</a>", false),
        ("<a href=\"DATA:text/html,<script>alert(1)</script>\">x</a>", false),
        ("<img src=\"javascript:alert(1)\" alt=\"j\">", false),
        ("[x](javascript:alert(1))", false),
        ("[x](JAVASCRIPT:alert(1))", false),
        ("[x](<java\tscript:alert(1)>)", false),
        ("[x](data:text/html,<script>alert(1)</script>)", false),
        ("[x](vbscript:msgbox)", false),
        ("[x]\n\n[x]: javascript:alert(1)", false),
        ("![x](javascript:alert(1)) ![y](\\\\evil\\share\\a.png) ![z](//evil/z.png) ![w](smb://evil/w.png)", false),
        ("<b style=\"background:url(http://evil/x)\" class=\"tp-img\" data-src=\"x\">styled</b>", false),
        // nested anchors and document-level elements
        ("<a href=\"http://a\"><a href=\"javascript:1\">x</a></a>", false),
        ("<base href=\"http://evil/\">", true),
        ("<meta http-equiv=\"refresh\" content=\"0;url=http://evil\">", true),
        ("<link rel=stylesheet href=http://evil/x.css>", true),
        ("<form action=\"http://evil\"><input type=submit formaction=\"javascript:1\"></form>", true),
        ("<img srcset=\"http://evil/x.png 1x\">", false),
        ("<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>", true),
        ("<object data=\"http://evil/x\"></object><embed src=\"http://evil/y\">", true),
        (
            "<video poster=\"http://evil/p.png\"></video><table background=\"http://evil/b\"><tr><td background=\"http://evil/c\">c</td></tr></table>",
            true,
        ),
        ("<details open ontoggle=alert(1)><summary onclick=1>s</summary>d</details>", false),
        // historical mXSS
        (
            "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;\">",
            true,
        ),
        ("<svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">", true),
        ("<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>", true),
        (
            "<math><mi><table><mi><mglyph><svg><mtext><textarea><path id=\"</textarea><img onerror=alert(1) src=1>\">",
            true,
        ),
        // link targets (brief §4.4, §4.6): inert data, never a live network-path href; attributes allowed tags mustn't keep
        ("<a href=\"file:///C:/x\">f</a> [f](file:///C:/x)", false),
        ("<a href=\"smb://h/s\">s</a> [s](smb://h/s)", false),
        ("<a href=\"//evil\">n</a> [n](//evil)", false),
        ("<a href=\"\\\\evil\\s\">u</a> [u](\\\\\\\\evil\\s)", false),
        ("<a href=\"  //evil\">w</a> [w](<  //evil>)", false),
        ("[[\\\\evil\\share]] [[\\\\\\evil\\share]] [[//evil/share]]", false),
        ("<a href=\"ms-settings:display\">o</a> [o](ms-settings:display)", false),
        ("<a ping=\"http://evil/p\" href=\"https://ok/\">p</a>", false),
        ("<a title=\"t\" target=\"_blank\" rel=\"opener\" href=\"https://ok/\">t</a>", false),
    ];

    /// The first tag in `payload` that isn't on the brief's allowlist, as written (its case kept).
    fn first_disallowed(payload: &str) -> Option<&str> {
        const ALLOWED: [&str; 20] = [
            "b", "i", "em", "strong", "code", "kbd", "sub", "sup", "br", "hr", "details", "summary", "a", "img",
            "table", "thead", "tbody", "tr", "th", "td",
        ];
        let b = payload.as_bytes();
        (0..b.len()).find_map(|i| {
            let start = i + 1 + usize::from(b.get(i + 1) == Some(&b'/'));
            if b[i] != b'<' || !b.get(start)?.is_ascii_alphabetic() {
                return None;
            }
            let end = (start..b.len()).find(|&j| !b[j].is_ascii_alphanumeric()).unwrap_or(b.len());
            let name = &payload[start..end];
            (!ALLOWED.contains(&name.to_ascii_lowercase().as_str())).then_some(name)
        })
    }

    /// The plan's planted cases (§3, PR 2's security acceptance), beside Spike C's corpus.
    const PLANTED: [&str; 7] = [
        "<link rel=preconnect href=https://example.invalid/>",
        "<link rel=\"dns-prefetch\" href=\"//example.invalid\">",
        "<meta http-equiv=refresh content=\"0;url=https://example.invalid/\">",
        "<base href=https://example.invalid/>",
        "<iframe src=https://example.invalid/></iframe>",
        "<svg><image href=https://example.invalid/i.png /></svg>",
        "![r](https://example.invalid/r.png) ![u](\\\\example.invalid\\s\\u.png) ![s](smb://example.invalid/s.png) <b style=\"background:url(https://example.invalid/b)\">c</b>",
    ];

    /// Payloads aimed at navigation: `target`, forms and form controls, `base`, `area`, `ping`, svg/math links.
    const NAV_PROBES: [&str; 12] = [
        "<a href=\"https://example.invalid/\" target=\"_top\">t</a>",
        "<a target=_blank href=x>b</a>",
        "<a href=\"x\" target=\"&#95;top\">e</a>",
        "<base target=\"_top\"><a href=\"x\">x</a>",
        "<form action=\"https://example.invalid/\"><button>go</button></form>",
        "<form><input type=\"submit\" formaction=\"https://example.invalid/\" formtarget=\"_top\"></form>",
        "<area href=\"https://example.invalid/\" target=\"_top\">",
        "<svg><a href=\"https://example.invalid/\" target=\"_top\"><text>s</text></a></svg>",
        "<math><a href=\"https://example.invalid/\" target=\"_top\">m</a></math>",
        "<details open><summary><a href=\"x\" target=\"_top\">s</a></summary></details>",
        "<a href=\"https://example.invalid/\" ping=\"https://example.invalid/p\" rel=\"opener\" download>p</a>",
        "[t](https://example.invalid/ \"title\"){target=_top}",
    ];

    /// Spike C's six contexts for every payload, plus front matter.
    fn contexts(payload: &str) -> [String; 7] {
        [
            format!("intro\n\n{payload}\n"),
            format!("x {payload} y\n"),
            format!("- {payload}\n"),
            format!("> {payload}\n"),
            format!("| a |\n|---|\n| {payload} |\n"),
            format!("# {payload}\n"),
            format!("---\n{payload}\n---\n"),
        ]
    }

    /// Brief §4.6 🔒: every payload, in every context, renders to output that passes `check_output`, and a disallowed
    /// tag shows as visible escaped text (Spike C's `gate_hostile_html_and_mxss` and `no_output_can_navigate`).
    #[test]
    fn the_hostile_corpus_stays_within_the_allowlists_and_every_href_is_hash() {
        let payloads = HOSTILE.iter().copied().chain(PLANTED.map(|p| (p, true))).chain(NAV_PROBES.map(|p| (p, false)));
        let mut outputs = 0;
        for (payload, literal) in payloads {
            for md in contexts(payload) {
                let r = render(&md);
                if let Err(e) = check_items(&r) {
                    panic!("{md:?}: {e}\n{:?}", r.items().iter().map(|i| &i.html).collect::<Vec<_>>());
                }
                outputs += r.items().len();
                let html: String = r.items().iter().map(|i| &*i.html).collect();
                if literal && let Some(name) = first_disallowed(payload) {
                    assert!(html.contains(&format!("&lt;{name}")), "{md:?}: <{name} isn't literal text in {html:?}");
                }
            }
        }
        println!(
            "{} payloads × 7 contexts: {outputs} items, all within the allowlists",
            HOSTILE.len() + PLANTED.len() + NAV_PROBES.len()
        );
    }

    /// The proptest's first find: ammonia repairs an `<a>` inside an `<a>` (by way of a table) into HTML that parses
    /// differently again, so one pass isn't idempotent. `clean`'s second pass settles it.
    #[test]
    fn a_repair_that_parses_differently_again_is_settled_by_a_second_pass() {
        let md = concat!(
            "<details><svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">",
            "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)><a href=\"javascript:alert(1)\">x</a>"
        );
        let mut raw = String::new();
        escape_raw(md, &mut raw);
        let once = sanitize(&raw);
        assert_ne!(sanitize(&once), once);
        check_items(&render(md)).unwrap();
    }

    /// Markdown and raw HTML atoms, the hostile corpus among them.
    fn atom() -> impl Strategy<Value = String> {
        let corpus: Vec<&str> = HOSTILE.iter().map(|h| h.0).chain(PLANTED).chain(NAV_PROBES).collect();
        let syntax = vec![
            "\n",
            "\n\n",
            "> ",
            "- ",
            "1. ",
            "# ",
            "| ",
            "|---|",
            "*",
            "_",
            "`",
            "```",
            "~~",
            "[",
            "]",
            "(",
            ")",
            "![",
            "<",
            ">",
            "</",
            "<a href=",
            "<img src=",
            "\"",
            "'",
            "&",
            "&#",
            ";",
            "javascript:",
            "data:",
            "//evil/",
            "\\\\evil\\",
            "=",
            " ",
            "\t",
            "\\",
            "[^n]",
            "[^n]: ",
            "<b>",
            "</b>",
            "<details>",
            "</details>",
            "<br>",
            "<!--",
            "-->",
            "---",
            "    ",
            "<td>",
            "<table>",
            "]: ",
            "<x@y.z>",
            "<http://h>",
            "\r",
        ];
        prop_oneof![
            2 => prop::sample::select(corpus).prop_map(String::from),
            6 => prop::sample::select(syntax).prop_map(String::from),
            2 => "[a-z0-9 ]{1,6}",
            1 => any::<char>().prop_map(String::from),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]

        /// Plan §3: the oracle holds on Markdown mixed with raw HTML and the hostile corpus.
        #[test]
        fn mixed_markdown_and_raw_html_stay_within_the_allowlists(atoms in prop::collection::vec(atom(), 0..48)) {
            let md = atoms.concat();
            let r = render(&md);
            if let Err(e) = check_items(&r) {
                return Err(TestCaseError::fail(format!("{md:?}: {e}")));
            }
        }
    }
}
