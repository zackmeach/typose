//! Bounded first-1,000-record display metadata. Values are never rewritten.
use super::{RowInfo, Span};
use crate::budget::Reservation;
use crate::doc::DocError;

pub const SAMPLE_ROWS: u64 = 1000;
pub const SAMPLE_FIELD_BYTES: usize = 512;
/// Columns that get sampled metadata, at 8 KiB each; the rest show as plain text.
pub const MAX_COLUMNS: usize = 512;
#[derive(Clone, Default)]
pub struct ColumnMetadata {
    pub width_units: usize,
    pub kind: String,
    pub pills: Option<Vec<String>>,
    values: Vec<String>,
    rows: u64,
    number: bool,
    boolean: bool,
    date: bool,
    url: bool,
    nonempty: bool,
    many_values: bool,
}
impl ColumnMetadata {
    fn sample(&mut self, text: &str, complete: bool) {
        if self.rows == 0 {
            self.number = true;
            self.boolean = true;
            self.date = true;
            self.url = true;
        }
        self.rows += 1;
        self.width_units =
            self.width_units.max(text.lines().map(|line| line.encode_utf16().count()).max().unwrap_or(0).min(41));
        if !text.trim().is_empty() {
            self.nonempty = true;
            self.number &= complete && text.trim().parse::<f64>().is_ok_and(|value| value.is_finite());
            self.boolean &= complete && matches!(text, "true" | "false" | "TRUE" | "FALSE");
            self.date &= complete && iso_date(text);
            self.url &= complete && (text.starts_with("https://") || text.starts_with("http://"));
        }
        if !complete || text.len() > 128 {
            self.many_values = true;
            self.values.clear();
        }
        if !self.many_values && !self.values.iter().any(|value| value == text) {
            if self.values.len() == 6 {
                self.many_values = true;
                self.values.clear();
            } else {
                self.values.push(text.into());
            }
        }
        self.kind = if !self.nonempty {
            "text"
        } else if self.number {
            "number"
        } else if self.boolean {
            "boolean"
        } else if self.date {
            "date"
        } else if self.url {
            "url"
        } else {
            "text"
        }
        .into();
    }
    fn freeze(&mut self) {
        self.pills =
            (self.kind == "text" && self.rows >= 12 && !self.many_values).then(|| std::mem::take(&mut self.values));
        self.values.clear();
    }
}
fn iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4].iter().chain(&bytes[5..7]).chain(&bytes[8..10]).all(u8::is_ascii_digit)
    {
        return false;
    }
    let month = text[5..7].parse::<u32>().unwrap_or(0);
    let day = text[8..10].parse::<u32>().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day) && (bytes.len() == 10 || matches!(bytes[10], b'T' | b' '))
}
#[derive(Clone)]
pub struct Problem {
    pub kind: &'static str,
    pub count: u64,
    pub first: Span,
    pub line: u64,
    pub record: Option<u64>,
}
pub struct Metadata {
    pub columns: Vec<ColumnMetadata>,
    pub done: bool,
    pub problems: Vec<Problem>,
    charge: Reservation,
    pending_utf8: Vec<u8>,
    pending_at: u64,
}
impl Default for Metadata {
    fn default() -> Self {
        Self::new()
    }
}
impl Metadata {
    pub fn new() -> Self {
        Self {
            columns: Vec::new(),
            done: false,
            problems: Vec::new(),
            charge: Reservation::none(),
            pending_utf8: Vec::with_capacity(4),
            pending_at: 0,
        }
    }
    pub fn charged(&self) -> u64 {
        self.charge.bytes()
    }
    pub fn sample(
        &mut self,
        record: u64,
        column: u64,
        header: bool,
        text: &str,
        complete: bool,
    ) -> Result<(), DocError> {
        if self.done || record < u64::from(header) || record - u64::from(header) >= SAMPLE_ROWS {
            return Ok(());
        }
        // Display metadata is a nicety: the first columns only, and none at all rather than a failed index.
        if column >= MAX_COLUMNS as u64 {
            return Ok(());
        }
        let column = column as usize;
        if column >= self.columns.len() {
            let extra = column + 1 - self.columns.len();
            if self.charge.grow(extra as u64 * 8192).is_err() {
                self.columns = Vec::new();
                self.charge = Reservation::none();
                self.done = true; // the Grid shows plain columns
                return Ok(());
            }
            self.columns.resize_with(column + 1, ColumnMetadata::default);
        }
        self.columns[column].sample(text, complete);
        Ok(())
    }
    pub fn row(&mut self, row: RowInfo, expected: u64, header: bool) {
        if row.record > 0 && row.fields != expected {
            self.problem("ragged", row.span, row.line, Some(row.record));
        }
        if row.record >= SAMPLE_ROWS - 1 + u64::from(header) {
            self.finish();
        }
    }
    pub fn finish(&mut self) {
        if !self.done {
            for column in &mut self.columns {
                column.freeze();
            }
            self.done = true;
        }
    }
    fn problem(&mut self, kind: &'static str, span: Span, line: u64, record: Option<u64>) {
        if let Some(group) = self.problems.iter_mut().find(|problem| problem.kind == kind) {
            group.count += 1;
        } else {
            self.problems.push(Problem { kind, count: 1, first: span, line, record });
        }
    }
    /// Original UTF-8 bytes, across read boundaries; legitimate U+FFFD does not count as a decoding error.
    pub fn utf8(&mut self, bytes: &[u8], start: u64, eof: bool) {
        let mut input = std::mem::take(&mut self.pending_utf8);
        let base = if input.is_empty() { start } else { self.pending_at };
        input.extend_from_slice(bytes);
        let mut at = 0;
        while at < input.len() {
            match std::str::from_utf8(&input[at..]) {
                Ok(_) => break,
                Err(error) => {
                    at += error.valid_up_to();
                    if let Some(count) = error.error_len() {
                        self.problem(
                            "decoding",
                            Span { start: base + at as u64, end: base + (at + count) as u64 },
                            0,
                            None,
                        );
                        at += count;
                    } else if eof {
                        self.problem(
                            "decoding",
                            Span { start: base + at as u64, end: base + input.len() as u64 },
                            0,
                            None,
                        );
                        break;
                    } else {
                        self.pending_utf8.extend_from_slice(&input[at..]);
                        self.pending_at = base + at as u64;
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sample_decisions_freeze_and_keep_first_appearance_order() {
        let mut metadata = Metadata::new();
        for record in 0..1000 {
            metadata.sample(record, 0, false, if record % 2 == 0 { "blue" } else { "red" }, true).unwrap();
            metadata.sample(record, 1, false, "001.20", true).unwrap();
        }
        metadata.finish();
        assert_eq!(metadata.columns[0].pills.as_ref().unwrap(), &vec!["blue".to_string(), "red".to_string()]);
        assert_eq!(metadata.columns[1].kind, "number");
        metadata.sample(1001, 0, false, "late", true).unwrap();
        assert_eq!(metadata.columns[0].pills.as_ref().unwrap().len(), 2);
    }
    #[test]
    fn only_the_first_512_columns_are_sampled_and_charged() {
        let mut metadata = Metadata::new();
        metadata.sample(0, 100_000, false, "far", true).unwrap();
        metadata.sample(0, 3, false, "near", true).unwrap();
        assert_eq!(metadata.columns.len(), 4);
        metadata.sample(0, 511, false, "last", true).unwrap();
        assert_eq!(metadata.columns.len(), 512);
        assert_eq!(metadata.charged(), 512 * 8192);
    }
    #[test]
    fn small_or_high_cardinality_columns_do_not_get_pills() {
        let mut metadata = Metadata::new();
        for record in 0..20 {
            metadata.sample(record, 0, false, &format!("value {record}"), true).unwrap();
        }
        for record in 0..11 {
            metadata.sample(record, 1, false, "small", true).unwrap();
        }
        metadata.finish();
        assert!(metadata.columns.iter().all(|column| column.pills.is_none()));
    }
    #[test]
    fn decoding_counts_invalid_sequences_across_boundaries_without_counting_real_replacement_text() {
        let mut metadata = Metadata::new();
        metadata.utf8(b"ok\xef\xbf\xbd\xf0\x9f", 0, false);
        metadata.utf8(b"\x98\x80\xffbad\xe2", 8, false);
        metadata.utf8(b"", 15, true);
        assert_eq!(metadata.problems[0].count, 2);
        assert_eq!(metadata.problems[0].first.start, 9);
    }
}
