//! Verified, charged CSV records and source-mapped field pieces. csv-core owns the quoting grammar.
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use csv_core::{ReadFieldResult, Reader, ReaderBuilder};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

use crate::budget::Reservation;
use crate::bytemap::{ByteMap, MapBuilder};
use crate::doc::{DocError, Document};
use crate::encoding::decode_prefix;
use crate::store::cancelled;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
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
                _charge: charge,
            }),
        })
    }
    pub fn charged(&self) -> u64 {
        self.index.read().unwrap()._charge.bytes()
    }
    fn publish_row(&self, event: &Event) {
        if let Event::Field { row: Some(row), .. } = event {
            let mut index = self.index.write().unwrap();
            if row.record == 0 {
                index.expected_columns = row.fields;
            }
            index.max_columns = index.max_columns.max(row.fields);
        }
    }
    pub fn build(&self, doc: &Document, mut progress: impl FnMut(u64, u64, bool) -> bool) -> Result<(), DocError> {
        if self.locked {
            return Ok(());
        }
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let mut scan = self.index.read().unwrap().checkpoints[0].clone();
        let mut next_cp = scan.pos + CP_BYTES;
        let mut out = [0u8; 4096];
        loop {
            check_cancel()?;
            let until = (scan.pos + READ_BYTES as u64).min(next_cp).min(doc.len());
            let bytes = read(doc, self.generation, scan.pos, until)?;
            let base = scan.pos;
            while scan.pos < until {
                check_cancel()?;
                let event = scan.step(&bytes[(scan.pos - base) as usize..], &mut out, |_, _| {});
                self.publish_row(&event);
            }
            if scan.pos == doc.len() {
                if scan.in_record {
                    let event = scan.step(&[], &mut out, |_, _| {});
                    self.publish_row(&event);
                }
                let mut index = self.index.write().unwrap();
                index.records = scan.record;
                index.indexed_bytes = scan.pos;
                index.done = true;
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
    pub fn page(
        &self,
        doc: &Document,
        row_start: u64,
        row_count: usize,
        column_start: u64,
        column_count: usize,
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
            let record = data_row + u64::from(self.header);
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
    fn csv(bytes: &[u8], delimiter: u8) -> (Temp, Document, Csv) {
        let path = temp_file("csv-core", bytes);
        let doc = Document::open(&path).unwrap();
        let csv = Csv::new(&doc, 1, 1, Options { delimiter: Some(delimiter), header: Some(false) }, UTF_8).unwrap();
        csv.build(&doc, |_, _, _| true).unwrap();
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
        let p = csv.page(&doc, 0, 128, 4900, 128).unwrap();
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
        header.build(&doc, |_, _, _| true).unwrap();
        assert_eq!(base.page(&doc, 0, 1, 0, 1).unwrap().rows[0].info.record, 0);
        assert_eq!(header.page(&doc, 0, 1, 0, 1).unwrap().rows[0].info.record, 1);
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
                        header &= !t.is_empty()
                            && !(t.parse::<f64>().is_ok() && t.bytes().any(|b| b.is_ascii_digit()))
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
