//! Verified, charged CSV records and source-mapped field pieces. csv-core owns the quoting grammar.
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use csv_core::{ReadFieldResult, Reader, ReaderBuilder};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

use crate::budget::Reservation;
use crate::bytemap::{ByteMap, MapBuilder};
use crate::doc::{DocError, Document};
use crate::encoding::decode_prefix;
pub use crate::json::Span;
use crate::store::cancelled;
#[path = "csv_metadata.rs"]
pub mod metadata;

pub const CP_BYTES: u64 = 1 << 20;
pub const READ_BYTES: usize = 64 << 10;
pub const PIECE_BYTES: usize = 4096;
pub const MAX_ROWS: usize = 128;
pub const MAX_COLUMNS: usize = 128;
pub const MAX_CELLS: usize = 512;
pub const MAX_UNITS: usize = 64 << 10;
pub const MAX_WIRE: usize = 256 << 10;
pub const TEMP_BYTES: u64 = 16 << 20;
pub const UTF16_REASON: &str = "Grid is unavailable for UTF-16 CSV/TSV. Open in Raw, or convert a copy to UTF-8.";
const DELIMITERS: [u8; 4] = [b',', b'\t', b';', b'|'];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    pub delimiter: Option<u8>,
    pub header: Option<bool>,
}
#[derive(Clone, Copy, Debug)]
pub struct RowInfo {
    pub record: u64,
    pub line: u64,
    pub span: Span,
    pub fields: u64,
}
pub struct Piece {
    pub record: u64,
    pub column: u64,
    pub span: Span,
    pub piece: Span,
    pub text: String,
    pub map: ByteMap,
    pub replacements: u32,
    pub next: Option<u64>,
    _charge: Option<Reservation>,
}
pub enum Cell {
    Value(Piece),
    Missing(u64),
}
pub struct Row {
    pub data_row: u64,
    pub info: RowInfo,
    pub cells: Vec<Cell>,
    pub complete: bool,
}
pub struct Page {
    pub rows: Vec<Row>,
    pub complete: bool,
    pub next: Option<(u64, u64)>,
    pub indexing: bool,
    _charge: Reservation,
}

/// State needed to map csv-core's unescaped bytes back onto original bytes, including at a checkpoint.
#[derive(Clone, Copy, Debug)]
struct QuoteMap {
    first: bool,
    quoted: bool,
    quote: bool,
    tail: [u8; 4],
    tail_len: usize,
}
impl QuoteMap {
    fn new() -> Self {
        Self { first: true, quoted: false, quote: false, tail: [0; 4], tail_len: 0 }
    }
    fn emit(&mut self, b: u8) {
        if self.tail_len == 4 {
            self.tail.copy_within(1.., 0);
            self.tail_len = 3;
        }
        self.tail[self.tail_len] = b;
        self.tail_len += 1;
    }
    fn feed(&mut self, raw: &[u8], offset: u64, mut emit: impl FnMut(u8, u64)) {
        for (i, &b) in raw.iter().enumerate() {
            if self.first {
                self.first = false;
                if b == b'"' {
                    self.quoted = true;
                    continue;
                }
            }
            if self.quoted {
                if self.quote {
                    self.quote = false;
                    if b == b'"' {
                        self.emit(b);
                        emit(b, offset + i as u64 + 1);
                        continue;
                    }
                    self.quoted = false;
                } else if b == b'"' {
                    self.quote = true;
                    continue;
                }
            }
            self.emit(b);
            emit(b, offset + i as u64 + 1);
        }
    }
    fn boundary(&self, encoding: &'static Encoding) -> bool {
        encoding != UTF_8 || decode_prefix(&self.tail[..self.tail_len], encoding, 1, 8, false).1 == self.tail_len
    }
}

#[derive(Clone, Debug)]
struct Scanner {
    reader: Reader,
    pos: u64,
    record: u64,
    column: u64,
    in_record: bool,
    record_start: u64,
    field_start: u64,
    line: u64,
    record_line: u64,
    field_line: u64,
    mapping: QuoteMap,
}
enum Event {
    Fed,
    Start,
    Field { record: u64, column: u64, line: u64, span: Span, row: Option<RowInfo> },
}
impl Scanner {
    fn new(delimiter: u8, offset: u64) -> Self {
        let mut reader = ReaderBuilder::new().delimiter(delimiter).build();
        // Disable csv-core's BOM stripping after the actual file BOM was handled once.
        reader.read_field(b"\n", &mut [0; 1]);
        Self {
            reader,
            pos: offset,
            record: 0,
            column: 0,
            in_record: false,
            record_start: offset,
            field_start: offset,
            line: 0,
            record_line: 0,
            field_line: 0,
            mapping: QuoteMap::new(),
        }
    }
    fn step(&mut self, input: &[u8], out: &mut [u8], mut emit: impl FnMut(u8, u64)) -> Event {
        if !self.in_record {
            let skip = input.iter().position(|b| !matches!(b, b'\r' | b'\n')).unwrap_or(input.len());
            self.line += memchr::memchr_iter(b'\n', &input[..skip]).count() as u64;
            self.pos += skip as u64;
            if skip == input.len() {
                return Event::Fed;
            }
            self.in_record = true;
            self.column = 0;
            self.record_start = self.pos;
            self.field_start = self.pos;
            self.record_line = self.line;
            self.field_line = self.line;
            self.mapping = QuoteMap::new();
            return Event::Start;
        }
        let start = self.pos;
        let (result, nin, _) = self.reader.read_field(input, out);
        self.pos += nin as u64;
        self.line += memchr::memchr_iter(b'\n', &input[..nin]).count() as u64;
        let completed = matches!(result, ReadFieldResult::Field { .. });
        let raw_len = nin.saturating_sub(usize::from(completed && nin > 0));
        self.mapping.feed(&input[..raw_len], start, &mut emit);
        if let ReadFieldResult::Field { record_end } = result {
            let span = Span { start: self.field_start, end: self.pos - u64::from(nin > 0) };
            let record = self.record;
            let column = self.column;
            let line = self.field_line;
            let row = record_end.then_some(RowInfo {
                record,
                line: self.record_line,
                span: Span { start: self.record_start, end: span.end },
                fields: column + 1,
            });
            self.column += 1;
            self.field_start = self.pos;
            self.field_line = self.line;
            self.mapping = QuoteMap::new();
            if record_end {
                self.record += 1;
                self.column = 0;
                self.in_record = false;
            }
            Event::Field { record, column, line, span, row }
        } else {
            Event::Fed
        }
    }
}

pub struct Index {
    checkpoints: Vec<Scanner>,
    pub records: u64,
    pub indexed_bytes: u64,
    pub done: bool,
    pub expected_columns: u64,
    pub max_columns: u64,
    pub metadata: metadata::Metadata,
    _charge: Reservation,
}
pub struct Csv {
    pub generation: u32,
    pub revision: u32,
    pub requested: Options,
    pub delimiter: u8,
    pub header: bool,
    pub encoding: &'static Encoding,
    pub locked: bool,
    pub index: RwLock<Index>,
}

fn check_cancel() -> Result<(), DocError> {
    if cancelled() { Err(DocError::Cancelled) } else { Ok(()) }
}
fn read(doc: &Document, generation: u32, start: u64, end: u64) -> Result<Vec<u8>, DocError> {
    check_cancel()?;
    doc.read(generation, start, end.min(doc.len()))
}

impl Csv {
    pub fn new(
        doc: &Document,
        generation: u32,
        revision: u32,
        options: Options,
        encoding: &'static Encoding,
    ) -> Result<Self, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        if options.delimiter.is_some_and(|d| !DELIMITERS.contains(&d)) {
            return Err(DocError::Invalid("unsupported CSV delimiter".into()));
        }
        let head = read(doc, generation, 0, READ_BYTES as u64)?;
        let locked = encoding == UTF_16LE
            || encoding == UTF_16BE
            || matches!(Encoding::for_bom(&head),Some((e,_)) if e==UTF_16LE || e==UTF_16BE);
        let forced = options.delimiter.or_else(|| {
            doc.path().extension().and_then(|s| s.to_str()).filter(|s| s.eq_ignore_ascii_case("tsv")).map(|_| b'\t')
        });
        let (delimiter, has_header) =
            if locked { (b',', false) } else { sniff(&head, head.len() as u64 == doc.len(), encoding, forced) };
        let header = options.header.unwrap_or(has_header);
        let count = if locked { 0 } else { doc.len().div_ceil(CP_BYTES) + 1 };
        let bytes = count
            .checked_mul(size_of::<Scanner>() as u64)
            .and_then(|n| n.checked_add(4096))
            .ok_or_else(|| DocError::Invalid("CSV checkpoint size overflow".into()))?;
        let charge = Reservation::new(bytes).map_err(DocError::Memory)?;
        let mut checkpoints = Vec::with_capacity(count as usize);
        if !locked {
            checkpoints.push(Scanner::new(delimiter, if head.starts_with(b"\xef\xbb\xbf") { 3 } else { 0 }));
        }
        Ok(Self {
            generation,
            revision,
            requested: options,
            delimiter,
            header,
            encoding,
            locked,
            index: RwLock::new(Index {
                checkpoints,
                records: 0,
                indexed_bytes: 0,
                done: locked,
                expected_columns: 0,
                max_columns: 0,
                metadata: metadata::Metadata::default(),
                _charge: charge,
            }),
        })
    }
    pub fn charged(&self) -> u64 {
        let index = self.index.read().unwrap();
        index._charge.bytes() + index.metadata.charged()
    }
    fn publish_row(&self, event: &Event) {
        if let Event::Field { row: Some(row), .. } = event {
            let mut index = self.index.write().unwrap();
            if row.record == 0 {
                index.expected_columns = row.fields;
            }
            index.max_columns = index.max_columns.max(row.fields);
            let expected = index.expected_columns;
            index.metadata.row(*row, expected, self.header);
        }
    }
    /// The NAPI candidate secures this allocation before replacing a usable configuration.
    pub fn build_reserved(
        &self,
        doc: &Document,
        mut progress: impl FnMut(u64, u64, bool) -> bool,
        _temp: Reservation,
    ) -> Result<(), DocError> {
        if self.locked {
            return Ok(());
        }
        let mut scan = self.index.read().unwrap().checkpoints[0].clone();
        let mut next_cp = scan.pos + CP_BYTES;
        let mut out = [0u8; 4096];
        let mut sample = Vec::with_capacity(metadata::SAMPLE_FIELD_BYTES);
        let mut sample_more = false;
        loop {
            check_cancel()?;
            let until = (scan.pos + READ_BYTES as u64).min(next_cp).min(doc.len());
            let bytes = read(doc, self.generation, scan.pos, until)?;
            let base = scan.pos;
            if self.encoding == UTF_8 {
                self.index.write().unwrap().metadata.utf8(&bytes, base, until == doc.len());
            }
            while scan.pos < until {
                check_cancel()?;
                let sampling = scan.record < metadata::SAMPLE_ROWS + u64::from(self.header);
                let event = scan.step(&bytes[(scan.pos - base) as usize..], &mut out, |byte, _| {
                    if sampling {
                        if sample.len() < metadata::SAMPLE_FIELD_BYTES {
                            sample.push(byte);
                        } else {
                            sample_more = true;
                        }
                    }
                });
                if let Event::Field { record, column, .. } = &event {
                    if sampling {
                        let text = self.encoding.decode_without_bom_handling(&sample).0;
                        self.index.write().unwrap().metadata.sample(
                            *record,
                            *column,
                            self.header,
                            &text,
                            !sample_more,
                        )?;
                    }
                    sample.clear();
                    sample_more = false;
                }
                self.publish_row(&event);
            }
            if scan.pos == doc.len() {
                if scan.in_record {
                    let event = scan.step(&[], &mut out, |byte, _| {
                        if sample.len() < metadata::SAMPLE_FIELD_BYTES {
                            sample.push(byte);
                        } else {
                            sample_more = true;
                        }
                    });
                    if let Event::Field { record, column, .. } = &event {
                        let text = self.encoding.decode_without_bom_handling(&sample).0;
                        self.index.write().unwrap().metadata.sample(
                            *record,
                            *column,
                            self.header,
                            &text,
                            !sample_more,
                        )?;
                    }
                    self.publish_row(&event);
                }
                let mut index = self.index.write().unwrap();
                index.records = scan.record;
                index.indexed_bytes = scan.pos;
                index.done = true;
                index.metadata.finish();
                drop(index);
                progress(scan.record, scan.pos, true);
                return Ok(());
            }
            {
                let mut index = self.index.write().unwrap();
                if scan.pos >= next_cp {
                    index.checkpoints.push(scan.clone());
                    next_cp = scan.pos + CP_BYTES;
                }
                index.records = scan.record;
                index.indexed_bytes = scan.pos;
            }
            if !progress(scan.record, scan.pos, false) {
                return Err(DocError::Cancelled);
            }
        }
    }
    fn checkpoint(&self, record: u64, column: Option<u64>, offset: Option<u64>) -> Option<Scanner> {
        let index = self.index.read().unwrap();
        if record >= index.records {
            return None;
        }
        let at = index.checkpoints.partition_point(|c| {
            c.record < record
                || (c.record == record && column.is_none_or(|col| c.column <= col) && offset.is_none_or(|p| c.pos <= p))
        });
        Some(index.checkpoints[at.saturating_sub(1)].clone())
    }
    fn run(
        &self,
        doc: &Document,
        scan: &mut Scanner,
        mut hit: impl FnMut(&Scanner, &Event) -> bool,
    ) -> Result<(), DocError> {
        let indexed = self.index.read().unwrap().indexed_bytes;
        let mut out = [0; 4096];
        while scan.pos < indexed {
            let bytes = read(doc, self.generation, scan.pos, (scan.pos + READ_BYTES as u64).min(indexed))?;
            let base = scan.pos;
            let end = base + bytes.len() as u64;
            while scan.pos < end {
                check_cancel()?;
                let event = scan.step(&bytes[(scan.pos - base) as usize..], &mut out, |_, _| {});
                if hit(scan, &event) {
                    return Ok(());
                }
            }
        }
        if scan.in_record {
            let event = scan.step(&[], &mut out, |_, _| {});
            hit(scan, &event);
        }
        Ok(())
    }
    pub fn row(&self, doc: &Document, record: u64) -> Result<Option<RowInfo>, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let Some(mut scan) = self.checkpoint(record, None, None) else { return Ok(None) };
        let mut row = None;
        self.run(doc, &mut scan, |_, event| {
            if let Event::Field { row: Some(r), .. } = event
                && r.record == record
            {
                row = Some(*r);
                true
            } else {
                false
            }
        })?;
        Ok(row)
    }
    pub fn field(&self, doc: &Document, record: u64, column: u64) -> Result<Option<(Span, u64)>, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let Some(mut scan) = self.checkpoint(record, Some(column), None) else { return Ok(None) };
        let mut field = None;
        self.run(doc, &mut scan, |_, event| {
            if let Event::Field { record: r, column: c, line, span, .. } = event
                && *r == record
                && *c == column
            {
                field = Some((*span, *line));
                true
            } else {
                false
            }
        })?;
        Ok(field)
    }
    fn advance(&self, doc: &Document, scan: &mut Scanner, until: u64) -> Result<(), DocError> {
        let mut out = [0; 4096];
        while scan.pos < until {
            let bytes = read(doc, self.generation, scan.pos, (scan.pos + READ_BYTES as u64).min(until))?;
            let base = scan.pos;
            let end = base + bytes.len() as u64;
            while scan.pos < end {
                check_cancel()?;
                scan.step(&bytes[(scan.pos - base) as usize..], &mut out, |_, _| {});
            }
        }
        Ok(())
    }
    pub fn piece(&self, doc: &Document, record: u64, column: u64, offset: Option<u64>) -> Result<Piece, DocError> {
        let charge = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let mut piece = self.piece_inner(doc, record, column, offset)?;
        piece._charge = Some(charge);
        Ok(piece)
    }
    fn piece_inner(&self, doc: &Document, record: u64, column: u64, offset: Option<u64>) -> Result<Piece, DocError> {
        let (span, _) =
            self.field(doc, record, column)?.ok_or_else(|| DocError::Invalid("CSV cell is not indexed".into()))?;
        let offset = offset.unwrap_or(span.start);
        if offset < span.start || offset > span.end {
            return Err(DocError::Invalid("CSV continuation is outside its field".into()));
        }
        let mut scan = if offset == span.start {
            let mut s = Scanner::new(self.delimiter, span.start);
            s.in_record = true;
            s.record = record;
            s.column = column;
            s
        } else {
            let mut s = self
                .checkpoint(record, Some(column), Some(offset))
                .ok_or_else(|| DocError::Invalid("CSV continuation is unavailable".into()))?;
            self.advance(doc, &mut s, offset)?;
            if s.record != record
                || s.column != column
                || !s.mapping.boundary(self.encoding)
                || (s.mapping.quote && offset < span.end)
            {
                return Err(DocError::Invalid("CSV continuation is not a field element boundary".into()));
            }
            s
        };
        let end = (offset + PIECE_BYTES as u64 + 4).min(span.end);
        let raw = read(doc, self.generation, offset, end)?;
        let mut val = Vec::with_capacity(raw.len());
        let mut at = Vec::with_capacity(raw.len());
        let mut out = [0; 4096];
        while scan.pos < end {
            check_cancel()?;
            scan.step(&raw[(scan.pos - offset) as usize..], &mut out, |b, p| {
                val.push(b);
                at.push(p);
            });
        }
        let complete = end == span.end;
        let (decoded, used) = decode_prefix(&val, self.encoding, 1, val.len(), complete);
        let cut = if complete { span.end } else { used.checked_sub(1).map_or(offset, |i| at[i]) };
        if !complete && cut <= offset {
            return Err(DocError::Invalid("CSV piece made no progress".into()));
        }
        let mut map = MapBuilder::with_capacity(offset, (cut - offset) as usize);
        let mut units = 0;
        let mut from = offset;
        let mut chars = decoded.text.chars().peekable();
        while let Some(c) = chars.next() {
            units += c.len_utf16() as u32;
            let value_end = (decoded.map.end_byte(units) - 2) as usize;
            let to = if complete && chars.peek().is_none() { span.end } else { at[value_end] };
            map.push(c.len_utf16() as u32, to - from);
            from = to;
        }
        if decoded.text.is_empty() && complete {
            map.push(0, span.end - offset);
        }
        Ok(Piece {
            record,
            column,
            span,
            piece: Span { start: offset, end: cut },
            text: decoded.text,
            map: map.finish(),
            replacements: decoded.replacements,
            next: (!complete).then_some(cut),
            _charge: None,
        })
    }
    pub fn ordered_page(
        &self,
        doc: &Document,
        row_start: u64,
        row_count: usize,
        column_start: u64,
        column_count: usize,
        order: Option<&Order>,
    ) -> Result<Page, DocError> {
        let charge = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        if row_count == 0 || row_count > MAX_ROWS || column_count == 0 || column_count > MAX_COLUMNS {
            return Err(DocError::Invalid("CSV rectangle exceeds its row/column bounds".into()));
        }
        let mut page = Page {
            rows: Vec::with_capacity(row_count),
            complete: true,
            next: None,
            indexing: !self.index.read().unwrap().done,
            _charge: charge,
        };
        let mut cells = 0;
        let mut units = 0;
        let mut wire = 1024;
        for data_row in row_start..row_start.saturating_add(row_count as u64) {
            check_cancel()?;
            let record = match order {
                Some(order) => match order.source(data_row) {
                    Some(record) => record,
                    None => break,
                },
                None => data_row + u64::from(self.header),
            };
            let Some(info) = self.row(doc, record)? else {
                if page.indexing {
                    page.complete = false;
                    page.next = Some((data_row, column_start));
                }
                break;
            };
            let mut row = Row { data_row, info, cells: Vec::with_capacity(column_count), complete: true };
            if wire + 1024 + 128 > MAX_WIRE {
                page.complete = false;
                page.next = Some((data_row, column_start));
                return Ok(page);
            }
            wire += 1024;
            for column in column_start..column_start.saturating_add(column_count as u64) {
                let cell = if column < info.fields {
                    Cell::Value(self.piece_inner(doc, record, column, None)?)
                } else {
                    Cell::Missing(column)
                };
                let (cost, text) = match &cell {
                    Cell::Value(p) => (p.wire_bytes(), p.map.units() as usize),
                    Cell::Missing(_) => (128, 0),
                };
                if cells >= MAX_CELLS || units + text > MAX_UNITS || wire + cost > MAX_WIRE {
                    row.complete = false;
                    page.complete = false;
                    page.next = Some((data_row, column));
                    page.rows.push(row);
                    return Ok(page);
                }
                wire += cost;
                units += text;
                cells += 1;
                row.cells.push(cell);
            }
            page.rows.push(row);
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{Temp, temp_file};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    fn csv(bytes: &[u8], delimiter: u8) -> (Temp, Document, Csv) {
        let name = format!("csv-core-{}", NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed));
        let path = temp_file(&name, bytes);
        let doc = Document::open(&path).unwrap();
        let csv = Csv::new(&doc, 1, 1, Options { delimiter: Some(delimiter), header: Some(false) }, UTF_8).unwrap();
        csv.build_reserved(&doc, |_, _, _| true, Reservation::none()).unwrap();
        (path, doc, csv)
    }
    #[test]
    fn safe_reader_clones_preserve_mid_quote_classes_and_partial_output() {
        for delimiter in DELIMITERS {
            let mut reader = Scanner::new(delimiter, 0).reader;
            reader.read_field(b"\"ab\n", &mut [0; 2]);
            let mut copied = reader.clone();
            let tail = [b"c\"\"d\"".as_slice(), &[delimiter], b"end\n"].concat();
            let parse = |r: &mut Reader| {
                let mut input = tail.as_slice();
                let mut out = [0; 2];
                let mut value = Vec::new();
                let mut ends = Vec::new();
                loop {
                    let (res, nin, nout) = r.read_field(input, &mut out);
                    input = &input[nin..];
                    value.extend_from_slice(&out[..nout]);
                    if let ReadFieldResult::Field { record_end } = res {
                        ends.push(value.len());
                        if record_end {
                            break;
                        }
                    }
                    if res == ReadFieldResult::End {
                        break;
                    }
                }
                (value, ends)
            };
            assert_eq!(parse(&mut copied), parse(&mut reader));
        }
    }
    #[test]
    fn metadata_samples_actual_unescaped_values_and_groups_full_file_problems() {
        let mut bytes = Vec::new();
        for record in 0..15 {
            bytes.extend_from_slice(format!("{},\"blue\",3.10\n", record).as_bytes());
        }
        bytes.extend_from_slice(b"late,red\nlast,\xff,1,extra\n");
        let (_path, doc, csv) = csv(&bytes, b',');
        let index = csv.index.read().unwrap();
        assert!(index.metadata.done);
        assert_eq!(index.metadata.columns[2].kind, "number");
        assert_eq!(index.metadata.columns[2].pills, None);
        assert_eq!(index.metadata.problems.iter().find(|problem| problem.kind == "ragged").unwrap().count, 2);
        assert_eq!(index.metadata.problems.iter().find(|problem| problem.kind == "decoding").unwrap().count, 1);
        drop(index);
        assert_eq!(csv.piece(&doc, 0, 2, None).unwrap().text, "3.10");
    }
    #[test]
    fn newline_less_row_and_original_quoted_spans_are_preserved() {
        let (_path, doc, csv) = csv(b"a,\"b\"\"c\",d", b',');
        let row = csv.row(&doc, 0).unwrap().unwrap();
        assert_eq!(row.fields, 3);
        assert_eq!(row.span, Span { start: 0, end: 10 });
        let i = csv.index.read().unwrap();
        assert_eq!((i.expected_columns, i.max_columns), (3, 3));
        drop(i);
        let piece = csv.piece(&doc, 0, 1, None).unwrap();
        assert_eq!(piece.text, "b\"c");
        assert_eq!(piece.span, Span { start: 2, end: 8 });
        assert_eq!(piece.map.start_byte(0), 2);
        assert_eq!(piece.map.end_byte(3), 8);
    }
    #[test]
    fn blank_lines_crlf_tsv_and_raw_lf_lines_remain_distinct() {
        let (_path, doc, csv) = csv(b"\n\r\na\tb\r\n\"x\ny\"\tz\rnext\tlast", b'\t');
        let first = csv.row(&doc, 0).unwrap().unwrap();
        let second = csv.row(&doc, 1).unwrap().unwrap();
        assert_eq!((first.line, second.line), (2, 3));
        assert_eq!(csv.piece(&doc, 1, 0, None).unwrap().text, "x\ny");
        assert_eq!(csv.row(&doc, 2).unwrap().unwrap().line, 4);
    }
    #[test]
    fn tiny_cells_and_escaped_controls_obey_all_page_bounds() {
        let data = ("a,".repeat(5000) + "end\n").repeat(3);
        let (_path, doc, csv) = csv(data.as_bytes(), b',');
        let p = csv.ordered_page(&doc, 0, 128, 4900, 128, None).unwrap();
        let mut cells = 0;
        let mut units = 0;
        let mut wire = 1024;
        for row in &p.rows {
            wire += 1024;
            for cell in &row.cells {
                cells += 1;
                match cell {
                    Cell::Value(v) => {
                        wire += v.wire_bytes();
                        units += v.map.units() as usize;
                    }
                    Cell::Missing(_) => wire += 128,
                }
            }
        }
        assert!(cells <= MAX_CELLS && units <= MAX_UNITS && wire <= MAX_WIRE);
        assert!(!p.complete);
        assert!(p.next.is_some());
    }
    #[test]
    fn far_column_and_field_continuation_resume_after_giant_quoted_data() {
        let mut data = b"\"".to_vec();
        data.extend_from_slice("😀\"\"x\n".repeat(200_000).as_bytes());
        data.extend_from_slice(b"\",tail\n");
        let (_path, doc, csv) = csv(&data, b',');
        assert_eq!(csv.piece(&doc, 0, 1, None).unwrap().text, "tail");
        let first = csv.piece(&doc, 0, 0, None).unwrap();
        let second = csv.piece(&doc, 0, 0, first.next).unwrap();
        assert!(first.next.is_some() && second.next.is_some());
        assert!(!first.text.contains('\u{fffd}'));
        assert!(!second.text.contains('\u{fffd}'));
        let cp = csv.checkpoint(0, Some(1), None).unwrap();
        assert!(data.len() as u64 - cp.pos <= CP_BYTES + 16);
        assert!(csv.piece(&doc, 0, 0, Some(3)).is_err()); // inside the opening emoji
    }
    #[test]
    fn header_is_a_projection_and_utf16_cannot_be_reinterpreted_into_grid() {
        let (_path, doc, base) = csv(b"name,value\nann,1", b',');
        let header = Csv::new(&doc, 1, 2, Options { delimiter: None, header: Some(true) }, UTF_8).unwrap();
        header.build_reserved(&doc, |_, _, _| true, Reservation::none()).unwrap();
        assert_eq!(base.ordered_page(&doc, 0, 1, 0, 1, None).unwrap().rows[0].info.record, 0);
        assert_eq!(header.ordered_page(&doc, 0, 1, 0, 1, None).unwrap().rows[0].info.record, 1);
        let (_path2, doc2, _) = csv(b"\xff\xfea\0,\0b\0", b',');
        assert!(Csv::new(&doc2, 1, 1, Options { delimiter: Some(b','), header: None }, UTF_8).unwrap().locked);
    }
}

impl Piece {
    /// Covers structured clone and conservative JSON escaping, including numeric typed-array keys/values.
    pub fn wire_bytes(&self) -> usize {
        let numbers = match &self.map {
            ByteMap::Uniform { pairs, .. } => pairs.len(),
            ByteMap::Breakpoints { points, .. } => 2 * points.len(),
        };
        1024 + 6 * self.text.encode_utf16().count() + 24 * numbers
    }
}

/// Bounded version of the frozen spike's delimiter/header scoring; candidates are processed one at a time.
fn sniff(sample: &[u8], whole: bool, encoding: &'static Encoding, forced: Option<u8>) -> (u8, bool) {
    let sample = sample.strip_prefix(b"\xef\xbb\xbf").unwrap_or(sample);
    let mut best = (forced.unwrap_or(b','), (0usize, 1usize, 1usize), false);
    for delimiter in DELIMITERS.into_iter().filter(|d| forced.is_none_or(|f| f == *d)) {
        let mut reader = Scanner::new(delimiter, 0).reader;
        let mut input = sample;
        let mut out = [0; 4096];
        let mut counts = HashMap::<usize, usize>::new();
        let mut rows = 0;
        let mut fields = 0;
        let mut first = true;
        let mut header = true;
        let mut seen = HashSet::new();
        let mut value = Vec::new();
        loop {
            if input.is_empty() && !whole {
                break;
            }
            let (result, nin, nout) = reader.read_field(input, &mut out);
            input = &input[nin..];
            if first {
                value.extend_from_slice(&out[..nout]);
            }
            match result {
                ReadFieldResult::Field { record_end } => {
                    fields += 1;
                    if first {
                        let text = encoding.decode_without_bom_handling(&value).0;
                        let t = text.trim();
                        header &= !(t.is_empty() || t.parse::<f64>().is_ok() && t.bytes().any(|b| b.is_ascii_digit()))
                            && seen.insert(t.to_owned());
                        value.clear();
                    }
                    if record_end {
                        *counts.entry(fields).or_default() += 1;
                        rows += 1;
                        fields = 0;
                        first = false;
                    }
                }
                ReadFieldResult::End => break,
                _ => {}
            }
        }
        let (mode, hits) = counts.into_iter().max_by_key(|&(n, h)| (h, n)).filter(|(n, _)| *n >= 2).unwrap_or((1, 0));
        let score = (hits, rows.max(1), mode);
        let old = best.1;
        if score.0 * old.1 > old.0 * score.1 || (score.0 * old.1 == old.0 * score.1 && score.2 > old.2) {
            best = (delimiter, score, header && !first);
        } else if delimiter == best.0 {
            best.2 = header && !first;
        }
    }
    (best.0, best.2)
}

/// A stable permutation and its inverse; strings used for sorting are transient and separately charged.
pub struct Order {
    pub rows: u64,
    pub header: u64,
    pub column: u64,
    pub direction: i32,
    source: Vec<u64>,
    inverse: Vec<u64>,
    _charge: Reservation,
}
impl Order {
    pub fn source(&self, row: u64) -> Option<u64> {
        if row >= self.rows {
            None
        } else if self.direction == 0 {
            Some(row + self.header)
        } else {
            Some(self.source[row as usize])
        }
    }
    pub fn locate(&self, record: u64) -> Option<u64> {
        let row = record.checked_sub(self.header)?;
        if row >= self.rows {
            None
        } else if self.direction == 0 {
            Some(row)
        } else {
            Some(self.inverse[row as usize])
        }
    }
    pub fn charged(&self) -> u64 {
        self._charge.bytes()
    }
}
struct SortKey {
    record: u64,
    text: String,
    number: Option<f64>,
}
impl Csv {
    pub fn order(&self, doc: &Document, column: u64, direction: i32) -> Result<Order, DocError> {
        let index = self.index.read().unwrap();
        if !index.done {
            return Err(DocError::Refused("Wait for CSV indexing before sorting".into()));
        }
        let rows = index.records.saturating_sub(u64::from(self.header));
        drop(index);
        let retained = 4096
            + if direction == 0 {
                0
            } else {
                rows.checked_mul(16).ok_or_else(|| DocError::Invalid("sort size overflow".into()))?
            };
        let charge = Reservation::new(retained).map_err(DocError::Memory)?;
        let mut result = Order {
            rows,
            header: u64::from(self.header),
            column,
            direction,
            source: Vec::new(),
            inverse: Vec::new(),
            _charge: charge,
        };
        if direction == 0 {
            return Ok(result);
        }
        let temp = doc
            .len()
            .checked_mul(10)
            .and_then(|n| n.checked_add(rows * 256 + TEMP_BYTES))
            .ok_or_else(|| DocError::Invalid("sort temporary size overflow".into()))?;
        let _temp = Reservation::new(temp).map_err(DocError::Memory)?;
        let mut keys = Vec::<SortKey>::with_capacity(rows as usize);
        let mut value = Vec::new();
        let mut scan = self.index.read().unwrap().checkpoints[0].clone();
        let mut out = [0; 4096];
        loop {
            check_cancel()?;
            let until = (scan.pos + READ_BYTES as u64).min(doc.len());
            let bytes = read(doc, self.generation, scan.pos, until)?;
            let base = scan.pos;
            while scan.pos < until {
                check_cancel()?;
                let capture = scan.column == column;
                let event = scan.step(&bytes[(scan.pos - base) as usize..], &mut out, |b, _| {
                    if capture {
                        value.push(b);
                    }
                });
                collect_key(self, &mut keys, &mut value, &event, column);
            }
            if scan.pos == doc.len() {
                if scan.in_record {
                    let capture = scan.column == column;
                    let event = scan.step(&[], &mut out, |b, _| {
                        if capture {
                            value.push(b);
                        }
                    });
                    collect_key(self, &mut keys, &mut value, &event, column);
                }
                break;
            }
        }
        let numeric = keys.iter().all(|k| k.text.trim().is_empty() || k.number.is_some())
            && keys.iter().any(|k| k.number.is_some());
        let compare = |a: usize, b: usize| {
            let (a, b) = (&keys[a], &keys[b]);
            let cmp = if numeric {
                match (a.number, b.number) {
                    (Some(a), Some(b)) => a.total_cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            } else {
                a.text.cmp(&b.text)
            };
            (if direction < 0 { cmp.reverse() } else { cmp }).then(a.record.cmp(&b.record))
        };
        let mut indices: Vec<usize> = (0..keys.len()).collect();
        for run in indices.chunks_mut(4096) {
            check_cancel()?;
            run.sort_unstable_by(|a, b| compare(*a, *b));
        }
        let mut scratch = vec![0; indices.len()];
        let mut width = 4096;
        while width < indices.len() {
            for start in (0..indices.len()).step_by(2 * width) {
                let middle = (start + width).min(indices.len());
                let end = (start + 2 * width).min(indices.len());
                let (mut a, mut b) = (start, middle);
                for (i, target) in scratch.iter_mut().enumerate().take(end).skip(start) {
                    if i % 4096 == 0 {
                        check_cancel()?;
                    }
                    if a < middle && (b == end || compare(indices[a], indices[b]).is_le()) {
                        *target = indices[a];
                        a += 1;
                    } else {
                        *target = indices[b];
                        b += 1;
                    }
                }
            }
            std::mem::swap(&mut indices, &mut scratch);
            width *= 2;
        }
        check_cancel()?;
        result.source = Vec::with_capacity(rows as usize);
        result.inverse = vec![0; rows as usize];
        for (index, row) in indices.into_iter().zip(0..rows) {
            let key = &keys[index];
            result.inverse[(key.record - result.header) as usize] = row;
            result.source.push(key.record);
        }
        Ok(result)
    }
}
fn collect_key(csv: &Csv, keys: &mut Vec<SortKey>, value: &mut Vec<u8>, event: &Event, column: u64) {
    if let Event::Field { record, column: c, row, .. } = event {
        if *c == column {
            if *record >= u64::from(csv.header) {
                let text = csv.encoding.decode_without_bom_handling(value).0.into_owned();
                let number = text.trim().parse::<f64>().ok().filter(|n| n.is_finite());
                keys.push(SortKey { record: *record, text, number });
            }
            value.clear();
        }
        if row.is_some() && *record >= u64::from(csv.header) && keys.last().is_none_or(|k| k.record != *record) {
            keys.push(SortKey { record: *record, text: String::new(), number: None });
        }
    }
}

#[cfg(test)]
mod interaction_tests {
    use super::*;
    use crate::store::testutil::temp_file;
    #[test]
    fn stable_numeric_order_preserves_source_numbers_and_bounded_pages() {
        let file = temp_file("csv-sort", b"name,rank\na,10\nb,2\nc,2\n");
        let doc = Document::open(&file).unwrap();
        let csv = Csv::new(&doc, 1, 1, Options { delimiter: Some(b','), header: Some(true) }, UTF_8).unwrap();
        csv.build_reserved(&doc, |_, _, _| true, Reservation::none()).unwrap();
        let order = csv.order(&doc, 1, 1).unwrap();
        assert_eq!((0..3).map(|r| order.source(r).unwrap()).collect::<Vec<_>>(), vec![2, 3, 1]);
        assert_eq!(order.locate(1), Some(2));
        let page = csv.ordered_page(&doc, 0, 3, 0, 2, Some(&order)).unwrap();
        assert_eq!(page.rows[0].info.record, 2);
        assert_eq!(page.rows[0].data_row, 0);
        let desc = csv.order(&doc, 1, -1).unwrap();
        assert_eq!((0..3).map(|r| desc.source(r).unwrap()).collect::<Vec<_>>(), vec![1, 2, 3]);
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GridHit {
    pub data_row: u64,
    pub record: u64,
    pub column: u64,
    pub start: u64,
    pub end: u64,
    pub within_row: u64,
}
impl GridHit {
    fn key(&self) -> (u64, u64, u64) {
        (self.data_row, self.column, self.start)
    }
}
#[derive(Clone)]
struct GridCursor {
    scan: Scanner,
    matcher: crate::find::Matcher,
    pending: Vec<u8>,
    positions: Vec<u64>,
    pending_start: u64,
    count: u64,
    counts: Vec<u64>,
    complete: bool,
}
pub struct GridProgress {
    pub count: u64,
    pub bytes: u64,
    pub complete: bool,
    pub hits: Vec<GridHit>,
}
pub struct GridFind {
    pattern: crate::find::Pattern,
    order: std::sync::Arc<Order>,
    cursor: std::sync::Mutex<GridCursor>,
    closed: std::sync::atomic::AtomicBool,
    _charge: Reservation,
}
impl GridFind {
    pub fn new(csv: &Csv, order: std::sync::Arc<Order>, query: &str, match_case: bool) -> Result<Self, DocError> {
        let charge = Reservation::new(
            crate::find::STATE_BYTES
                + order.rows.checked_mul(8).ok_or_else(|| DocError::Invalid("Grid Find state size overflow".into()))?,
        )
        .map_err(DocError::Memory)?;
        let pattern = crate::find::Pattern::new(query, match_case)?;
        let scan = csv.index.read().unwrap().checkpoints[0].clone();
        let matcher = crate::find::Matcher::new(&pattern);
        let cursor = GridCursor {
            pending_start: scan.field_start,
            scan,
            matcher,
            pending: Vec::new(),
            positions: Vec::new(),
            count: 0,
            counts: vec![0; order.rows as usize],
            complete: false,
        };
        Ok(Self {
            pattern,
            order,
            cursor: std::sync::Mutex::new(cursor),
            closed: std::sync::atomic::AtomicBool::new(false),
            _charge: charge,
        })
    }
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn charged(&self) -> u64 {
        self._charge.bytes()
    }
    pub fn order_charged(&self) -> u64 {
        self.order.charged()
    }
    fn feed(
        &self,
        csv: &Csv,
        c: &mut GridCursor,
        record: u64,
        column: u64,
        last: bool,
        mut found: impl FnMut(GridHit),
    ) -> Result<(), DocError> {
        let (slice, used) = decode_prefix(&c.pending, csv.encoding, 1, c.pending.len(), last);
        let mut units = 0;
        for ch in slice.text.chars() {
            let from = (slice.map.start_byte(units) - 1) as usize;
            units += ch.len_utf16() as u32;
            let to = (slice.map.end_byte(units) - 1) as usize;
            let start = if from == 0 { c.pending_start } else { c.positions[from - 1] };
            let end = c.positions[to - 1];
            if let Some(data_row) = self.order.locate(record) {
                let position = crate::find::Hit { start, end, line: 0, line_start: 0, ordinal: 0 };
                c.matcher.feed(&self.pattern, ch, position, |hit| {
                    c.count += 1;
                    c.counts[(record - self.order.header) as usize] += 1;
                    found(GridHit {
                        data_row,
                        record,
                        column,
                        start: hit.start,
                        end: hit.end,
                        within_row: c.counts[(record - self.order.header) as usize],
                    });
                });
            }
        }
        if used > 0 {
            c.pending_start = c.positions[used - 1];
            c.pending.drain(..used);
            c.positions.drain(..used);
        }
        if last {
            c.pending.clear();
            c.positions.clear();
            c.matcher.reset();
            c.pending_start = c.scan.field_start;
        }
        Ok(())
    }
    fn step(
        &self,
        csv: &Csv,
        doc: &Document,
        c: &mut GridCursor,
        limit: u64,
        mut found: impl FnMut(GridHit),
    ) -> Result<(), DocError> {
        let stop = (c.scan.pos + limit).min(doc.len());
        let mut out = [0; 4096];
        while c.scan.pos < stop {
            check_cancel()?;
            if self.closed.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            let until = (c.scan.pos + READ_BYTES as u64).min(doc.len());
            let bytes = read(doc, csv.generation, c.scan.pos, until)?;
            let base = c.scan.pos;
            while c.scan.pos < until {
                check_cancel()?;
                let (record, column) = (c.scan.record, c.scan.column);
                let event = c.scan.step(&bytes[(c.scan.pos - base) as usize..], &mut out, |b, p| {
                    c.pending.push(b);
                    c.positions.push(p);
                });
                if matches!(event, Event::Start) {
                    c.pending_start = c.scan.field_start;
                }
                self.feed(csv, c, record, column, matches!(event, Event::Field { .. }), &mut found)?;
            }
        }
        if c.scan.pos == doc.len() {
            if c.scan.in_record {
                let (record, column) = (c.scan.record, c.scan.column);
                let event = c.scan.step(&[], &mut out, |b, p| {
                    c.pending.push(b);
                    c.positions.push(p);
                });
                self.feed(csv, c, record, column, matches!(event, Event::Field { .. }), &mut found)?;
            }
            c.complete = true;
        }
        Ok(())
    }
    pub fn scan(&self, csv: &Csv, doc: &Document) -> Result<GridProgress, DocError> {
        let _temp = Reservation::new(TEMP_BYTES + self.order.rows * 8).map_err(DocError::Memory)?;
        let mut held = self.cursor.lock().unwrap();
        let mut c = held.clone();
        let mut hits = Vec::with_capacity(crate::find::HIT_LIMIT);
        self.step(csv, doc, &mut c, crate::find::SCAN_BYTES, |h| {
            if hits.len() < crate::find::HIT_LIMIT {
                hits.push(h);
            }
        })?;
        let result = GridProgress { count: c.count, bytes: c.scan.pos, complete: c.complete, hits };
        *held = c;
        Ok(result)
    }
    pub fn seek(
        &self,
        csv: &Csv,
        doc: &Document,
        from: Option<GridHit>,
        previous: bool,
    ) -> Result<(Option<GridHit>, bool, Option<u64>), DocError> {
        let _temp = Reservation::new(TEMP_BYTES + self.order.rows * 8).map_err(DocError::Memory)?;
        let scan = csv.index.read().unwrap().checkpoints[0].clone();
        let mut c = GridCursor {
            pending_start: scan.field_start,
            scan,
            matcher: crate::find::Matcher::new(&self.pattern),
            pending: Vec::new(),
            positions: Vec::new(),
            count: 0,
            counts: vec![0; self.order.rows as usize],
            complete: false,
        };
        let (mut first, mut last, mut chosen): (Option<GridHit>, Option<GridHit>, Option<GridHit>) = (None, None, None);
        while !c.complete {
            self.step(csv, doc, &mut c, crate::find::SCAN_BYTES, |h| {
                if first.is_none_or(|old| h.key() < old.key()) {
                    first = Some(h);
                }
                if last.is_none_or(|old| h.key() > old.key()) {
                    last = Some(h);
                }
                let eligible = from.is_none_or(|at| if previous { h.key() < at.key() } else { h.key() > at.key() });
                if eligible && chosen.is_none_or(|old| if previous { h.key() > old.key() } else { h.key() < old.key() })
                {
                    chosen = Some(h);
                }
            })?;
        }
        let wrapped = chosen.is_none() && from.is_some();
        let selected = chosen.or(if previous { last } else { first });
        let ordinal = selected.map(|h| {
            let mut count = h.within_row;
            for row in 0..h.data_row {
                count += c.counts[(self.order.source(row).unwrap() - self.order.header) as usize];
            }
            count
        });
        Ok((selected, wrapped, ordinal))
    }
}

#[cfg(test)]
mod grid_find_tests {
    use super::*;
    use crate::store::testutil::temp_file;
    use std::sync::Arc;
    #[test]
    fn native_find_crosses_quoted_chunks_and_seeks_in_stable_sort_order() {
        let mut data = b"name,rank\n\"".to_vec();
        data.extend(vec![b'x'; 70_000]);
        data.extend_from_slice("ÉCOLE\",10\nÉcole,2\nÉCOLE,2\n".as_bytes());
        let file = temp_file("grid-find", &data);
        let doc = Document::open(&file).unwrap();
        let csv = Csv::new(&doc, 1, 1, Options { delimiter: Some(b','), header: Some(true) }, UTF_8).unwrap();
        csv.build_reserved(&doc, |_, _, _| true, Reservation::none()).unwrap();
        let order = Arc::new(csv.order(&doc, 1, 1).unwrap());
        let search = GridFind::new(&csv, order, "école", false).unwrap();
        let p = search.scan(&csv, &doc).unwrap();
        assert_eq!(p.count, 3);
        assert!(p.complete);
        let (first, wrapped, n) = search.seek(&csv, &doc, None, false).unwrap();
        let first = first.unwrap();
        assert!(!wrapped);
        assert_eq!((first.record, first.data_row, n), (2, 0, Some(1)));
        let (last, wrapped, n) = search.seek(&csv, &doc, Some(first), true).unwrap();
        assert!(wrapped);
        assert_eq!((last.unwrap().record, n), (1, Some(3)));
    }
}
