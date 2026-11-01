//! Generation/revision-owned CSV jobs and cancellable bounded native pages.
use super::*;
use std::sync::atomic::{AtomicU32, AtomicU64};
use typose_core::csv as core_csv;

pub(super) fn supported(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("csv") || x.eq_ignore_ascii_case("tsv"))
}
pub struct State {
    csv: core_csv::Csv,
    cancel: Arc<AtomicBool>,
    error: Mutex<Option<String>>,
}
#[derive(Default)]
pub(super) struct Owner {
    state: Mutex<Option<Arc<State>>>,
    epoch: AtomicU64,
    revision: AtomicU32,
    closed: AtomicBool,
}
impl Owner {
    #[cfg(feature = "test-hooks")]
    pub(super) fn charged(&self) -> u64 {
        self.state.lock().unwrap().as_ref().map_or(0, |state| state.csv.charged())
    }
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Some(state) = self.state.lock().unwrap().take() {
            state.cancel.store(true, Ordering::Relaxed);
        }
    }
    fn current(&self, state: &Arc<State>) -> bool {
        !self.closed.load(Ordering::Relaxed)
            && self.state.lock().unwrap().as_ref().is_some_and(|s| Arc::ptr_eq(s, state))
    }
}

#[napi(object)]
pub struct CsvSpan {
    pub start: f64,
    pub end: f64,
}
#[napi(object)]
pub struct CsvInfo {
    pub revision: u32,
    pub status: String,
    pub reason: Option<String>,
    pub delimiter: String,
    pub header: bool,
    pub encoding: String,
    pub source_records: f64,
    pub indexed_bytes: f64,
    pub done: bool,
    pub expected_columns: f64,
    pub max_columns_known: f64,
    pub metadata_done: bool,
}
#[napi(object)]
pub struct CsvContinuation {
    pub source_record: f64,
    pub column: f64,
    pub offset: f64,
}
#[napi(object)]
pub struct CsvCellPiece {
    pub source_record: f64,
    pub column: f64,
    pub span: CsvSpan,
    pub piece_span: CsvSpan,
    pub text: String,
    pub map: WireMap,
    pub replacements: u32,
    pub next: Option<CsvContinuation>,
}
#[napi(object)]
pub struct CsvCell {
    pub column: f64,
    pub value: Option<CsvCellPiece>,
}
#[napi(object)]
pub struct CsvRow {
    pub data_row: f64,
    pub source_record: f64,
    pub source_line: f64,
    pub span: CsvSpan,
    pub field_count: f64,
    pub cells: Vec<CsvCell>,
    pub complete: bool,
}
#[napi(object)]
pub struct CsvPage {
    pub rows: Vec<CsvRow>,
    pub complete_rect: bool,
    pub next_row: Option<f64>,
    pub next_column: Option<f64>,
    pub indexing: bool,
}
#[napi(object)]
pub struct CsvColumn {
    pub column: f64,
    pub name: String,
    pub name_more: bool,
    #[napi(js_name = "type")]
    pub kind: String,
    pub width_units: f64,
    pub pills: Option<Vec<String>>,
}
#[napi(object)]
pub struct CsvColumnPage {
    pub columns: Vec<CsvColumn>,
    pub next_column: Option<f64>,
    pub metadata_done: bool,
}
#[napi(object)]
pub struct CsvLocated {
    pub kind: String,
    pub data_row: Option<f64>,
    pub source_record: Option<f64>,
    pub source_line: Option<f64>,
    pub span: Option<CsvSpan>,
    pub column: Option<f64>,
}
#[napi(object)]
pub struct CsvSource {
    pub kind: String,
    pub span: Option<CsvSpan>,
    pub raw_line: Option<f64>,
}

fn span(s: core_csv::Span) -> CsvSpan {
    CsvSpan { start: s.start as f64, end: s.end as f64 }
}
fn piece(p: core_csv::Piece) -> CsvCellPiece {
    let w = p.map.to_wire();
    CsvCellPiece {
        source_record: p.record as f64,
        column: p.column as f64,
        span: span(p.span),
        piece_span: span(p.piece),
        text: p.text,
        map: WireMap {
            uniform: w.uniform,
            start: w.start as f64,
            end: w.end as f64,
            units: w.units,
            unit_bytes: w.unit_bytes,
            points: Uint32Array::new(w.points),
        },
        replacements: p.replacements,
        next: p.next.map(|offset| CsvContinuation {
            source_record: p.record as f64,
            column: p.column as f64,
            offset: offset as f64,
        }),
    }
}
fn info(state: &State) -> CsvInfo {
    let index = state.csv.index.read().unwrap();
    let error = state.error.lock().unwrap().clone();
    CsvInfo {
        revision: state.csv.revision,
        status: if state.csv.locked || error.is_some() {
            "locked"
        } else if index.done {
            "ready"
        } else {
            "indexing"
        }
        .into(),
        reason: if state.csv.locked { Some(core_csv::UTF16_REASON.into()) } else { error },
        delimiter: (state.csv.delimiter as char).to_string(),
        header: state.csv.header,
        encoding: state.csv.encoding.name().into(),
        source_records: index.records as f64,
        indexed_bytes: index.indexed_bytes as f64,
        done: index.done,
        expected_columns: index.expected_columns as f64,
        max_columns_known: index.max_columns as f64,
        metadata_done: false,
    }
}
fn stale(revision: u32) -> DocError {
    DocError::Stale { current: 0, asked: revision }
}
fn source_check(raw: &Raw, generation: u32) -> std::result::Result<(), DocError> {
    raw.document().verified(generation, |_| Ok(()))
}
fn page_slot() -> std::result::Result<Slot, DocError> {
    budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
        NoSlot::Cancelled => DocError::Cancelled,
        NoSlot::Budget(e) => DocError::Memory(e),
    })
}
fn err(env: Env, e: DocError) -> Error {
    Error::from(JsError::from(doc_error(e)).into_unknown(env))
}

pub struct Configure {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    options: core_csv::Options,
    generation: u32,
    revision: u32,
    epoch: u64,
    existing: Option<Arc<State>>,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    build_slot: Option<Slot>,
    build_temp: Option<Reservation>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Configure {
    type Output = std::result::Result<Arc<State>, DocError>;
    type JsValue = CsvInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(cancellable(&self.cancel, || {
            if let Some(state) = &self.existing {
                return Ok(state.clone());
            }
            self.slot = Some(page_slot()?);
            source_check(&self.raw, self.generation)?;
            let csv = self.raw.csv(self.generation, self.revision, self.options)?;
            if !csv.locked {
                let stop = || {
                    store::cancelled()
                        || self.owner.closed.load(Ordering::Relaxed)
                        || self.owner.epoch.load(Ordering::Relaxed) != self.epoch
                };
                self.build_slot = Some(budget::slot(Work::Index, &stop).map_err(|e| match e {
                    NoSlot::Cancelled => DocError::Cancelled,
                    NoSlot::Budget(e) => DocError::Memory(e),
                })?);
                self.build_temp = Some(Reservation::new(core_csv::TEMP_BYTES).map_err(DocError::Memory)?);
            }
            Ok(Arc::new(State { csv, cancel: Arc::new(AtomicBool::new(false)), error: Mutex::new(None) }))
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<CsvInfo> {
        let result = (|| {
            let state = output?;
            if self.cancel.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            if self.owner.closed.load(Ordering::Relaxed) || self.owner.epoch.load(Ordering::Relaxed) != self.epoch {
                return Err(stale(self.revision));
            }
            if self.existing.is_some() {
                if !self.owner.current(&state) {
                    return Err(stale(self.revision));
                }
                return Ok(info(&state));
            }
            source_check(&self.raw, self.generation)?;
            // A poll never spawns another job. Each changed configuration owns exactly this one worker/flag.
            if !state.csv.locked {
                let raw = self.raw.clone();
                let work = state.clone();
                let slot = self.build_slot.take().expect("fresh CSV candidate owns its index slot");
                let temp = self.build_temp.take().expect("fresh CSV candidate owns its index work");
                #[cfg(feature = "test-hooks")]
                let job = hooks::Live::new(&hooks::JOBS);
                std::thread::Builder::new()
                    .name("typose-csv".into())
                    .spawn(move || {
                        #[cfg(feature = "test-hooks")]
                        let _job = job;
                        let _slot = slot;
                        let flag = work.cancel.clone();
                        let result = cancellable(&flag, || {
                            work.csv.build_reserved(raw.document(), |_, _, _| !flag.load(Ordering::Relaxed), temp)
                        });
                        if let Err(e) = result
                            && !matches!(e, DocError::Cancelled)
                        {
                            *work.error.lock().unwrap() = Some(e.to_string().chars().take(512).collect());
                        }
                    })
                    .map_err(DocError::Io)?;
            }
            if let Some(old) = self.owner.state.lock().unwrap().replace(state.clone()) {
                old.cancel.store(true, Ordering::Relaxed);
            }
            Ok(info(&state))
        })();
        result.map_err(|e| err(env, e))
    }
}

pub struct Context {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    state: Arc<State>,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Context {
    fn check(&self) -> std::result::Result<(), DocError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(DocError::Cancelled);
        }
        if !self.owner.current(&self.state) {
            return Err(stale(self.state.csv.revision));
        }
        source_check(&self.raw, self.state.csv.generation)
    }
}
pub trait Query: Send + 'static {
    type Output: Send;
    type JsValue: ToNapiValue + TypeName;
    fn run(&self, ctx: &Context) -> std::result::Result<Self::Output, DocError>;
    fn convert(&self, output: Self::Output) -> Self::JsValue;
}
pub struct ReadCsv<Q: Query> {
    ctx: Context,
    query: Q,
}
impl<Q: Query> Task for ReadCsv<Q> {
    type Output = std::result::Result<Q::Output, DocError>;
    type JsValue = Q::JsValue;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.ctx.cancel.clone();
        Ok(cancellable(&flag, || {
            self.ctx.slot = Some(page_slot()?);
            self.ctx.check()?;
            self.query.run(&self.ctx)
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output.and_then(|out| {
            self.ctx.check()?;
            Ok(self.query.convert(out))
        });
        result.map_err(|e| err(env, e))
    }
}
pub struct PageQuery {
    row: u64,
    rows: usize,
    column: u64,
    columns: usize,
}
impl Query for PageQuery {
    type Output = core_csv::Page;
    type JsValue = CsvPage;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        c.state.csv.page(c.raw.document(), self.row, self.rows, self.column, self.columns)
    }
    fn convert(&self, p: Self::Output) -> CsvPage {
        CsvPage {
            rows: p
                .rows
                .into_iter()
                .map(|r| CsvRow {
                    data_row: r.data_row as f64,
                    source_record: r.info.record as f64,
                    source_line: r.info.line as f64,
                    span: span(r.info.span),
                    field_count: r.info.fields as f64,
                    complete: r.complete,
                    cells: r
                        .cells
                        .into_iter()
                        .map(|c| match c {
                            core_csv::Cell::Value(p) => CsvCell { column: p.column as f64, value: Some(piece(p)) },
                            core_csv::Cell::Missing(column) => CsvCell { column: column as f64, value: None },
                        })
                        .collect(),
                })
                .collect(),
            complete_rect: p.complete,
            next_row: p.next.map(|p| p.0 as f64),
            next_column: p.next.map(|p| p.1 as f64),
            indexing: p.indexing,
        }
    }
}
pub struct PieceQuery {
    record: u64,
    column: u64,
    offset: u64,
}
impl Query for PieceQuery {
    type Output = core_csv::Piece;
    type JsValue = CsvCellPiece;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        c.state.csv.piece(c.raw.document(), self.record, self.column, Some(self.offset))
    }
    fn convert(&self, p: Self::Output) -> CsvCellPiece {
        piece(p)
    }
}
pub struct ColumnsQuery {
    start: u64,
    count: usize,
}
impl Query for ColumnsQuery {
    type Output = CsvColumnPage;
    type JsValue = CsvColumnPage;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let width = c.state.csv.index.read().unwrap().expected_columns;
        let mut columns = Vec::with_capacity(self.count);
        for column in self.start..self.start.saturating_add(self.count as u64).min(width) {
            if store::cancelled() {
                return Err(DocError::Cancelled);
            }
            let (name, name_more) = if c.state.csv.header {
                let p = c.state.csv.piece(c.raw.document(), 0, column, None)?;
                let mut units = 0;
                let name: String = p
                    .text
                    .chars()
                    .take_while(|ch| {
                        units += ch.len_utf16();
                        units <= 128
                    })
                    .collect();
                let more = p.next.is_some() || name.len() != p.text.len();
                (name, more)
            } else {
                (format!("Column {}", column + 1), false)
            };
            let width_units =
                name.lines().map(|line| line.encode_utf16().count()).max().unwrap_or(0).clamp(12, 60) as f64;
            columns.push(CsvColumn {
                column: column as f64,
                name,
                name_more,
                kind: "text".into(),
                width_units,
                pills: None,
            });
        }
        let next = self.start + columns.len() as u64;
        Ok(CsvColumnPage { columns, next_column: (next < width).then_some(next as f64), metadata_done: false })
    }
    fn convert(&self, p: Self::Output) -> CsvColumnPage {
        p
    }
}
pub struct SourceQuery {
    record: u64,
    column: Option<u64>,
}
impl Query for SourceQuery {
    type Output = CsvSource;
    type JsValue = CsvSource;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let source = if let Some(column) = self.column {
            c.state.csv.field(c.raw.document(), self.record, column)?
        } else {
            c.state.csv.row(c.raw.document(), self.record)?.map(|r| (r.span, r.line))
        };
        Ok(match source {
            Some((s, line)) => CsvSource { kind: "located".into(), span: Some(span(s)), raw_line: Some(line as f64) },
            None => CsvSource { kind: "pending".into(), span: None, raw_line: None },
        })
    }
    fn convert(&self, p: Self::Output) -> CsvSource {
        p
    }
}
pub struct LocateQuery {
    line: Option<u64>,
    offset: Option<u64>,
}
impl Query for LocateQuery {
    type Output = CsvLocated;
    type JsValue = CsvLocated;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let pending = || CsvLocated {
            kind: "pending".into(),
            data_row: None,
            source_record: None,
            source_line: None,
            span: None,
            column: None,
        };
        let offset = if let Some(line) = self.line {
            let Some(p) = c.raw.line_offset(c.state.csv.generation, line)? else { return Ok(pending()) };
            p
        } else {
            self.offset.unwrap()
        };
        let index = c.state.csv.index.read().unwrap();
        let (records, indexed, done) = (index.records, index.indexed_bytes, index.done);
        drop(index);
        if records == 0 || offset > indexed || (offset == indexed && !done) {
            return Ok(pending());
        }
        let (mut lo, mut hi) = (0, records);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let Some(row) = c.state.csv.row(c.raw.document(), mid)? else { return Ok(pending()) };
            if row.span.end < offset {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let record = lo.min(records - 1).max(u64::from(c.state.csv.header).min(records - 1));
        let Some(row) = c.state.csv.row(c.raw.document(), record)? else { return Ok(pending()) };
        Ok(CsvLocated {
            kind: "located".into(),
            data_row: Some(record.saturating_sub(u64::from(c.state.csv.header)) as f64),
            source_record: Some(record as f64),
            source_line: Some(row.line as f64),
            span: Some(span(row.span)),
            column: None,
        })
    }
    fn convert(&self, p: Self::Output) -> CsvLocated {
        p
    }
}

fn count(value: f64, max: usize, name: &str) -> std::result::Result<usize, Error<Code>> {
    let n = int("count", value)?;
    if n > max as u64 {
        return Err(Error::new(Code::InvalidParams, format!("{name} exceeds {max}")));
    }
    Ok(n as usize)
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<CsvInfo>")]
    pub fn csv_configure(
        &self,
        generation: f64,
        delimiter: String,
        header: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Configure>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let delimiter = match delimiter.as_str() {
            "auto" => None,
            "," => Some(b','),
            "\t" => Some(b'\t'),
            ";" => Some(b';'),
            "|" => Some(b'|'),
            _ => return Err(Error::new(Code::InvalidParams, "unsupported CSV delimiter")),
        };
        let header = match header {
            0.0 => None,
            1.0 => Some(true),
            -1.0 => Some(false),
            _ => return Err(Error::new(Code::InvalidParams, "header must be -1, 0 or 1")),
        };
        let raw = self.raw()?;
        if raw.document().generation() != generation {
            return Err(doc_error(DocError::Stale { current: raw.document().generation(), asked: generation }));
        }
        if !supported(raw.document().path()) {
            return Err(Error::new(Code::Refused, "Grid is available for CSV/TSV files"));
        }
        let options = core_csv::Options { delimiter, header };
        let existing = self.csv.state.lock().unwrap().as_ref().filter(|s| s.csv.requested == options).cloned();
        let charge = Reservation::new(if existing.is_some() { 4096 } else { core_csv::TEMP_BYTES })
            .map_err(|e| doc_error(DocError::Memory(e)))?;
        let (revision, epoch) = if let Some(state) = &existing {
            (state.csv.revision, self.csv.epoch.load(Ordering::Relaxed))
        } else {
            let revision = self
                .csv
                .revision
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
                .map_err(|_| Error::new(Code::Refused, "CSV revisions exhausted"))?
                + 1;
            (revision, self.csv.epoch.fetch_add(1, Ordering::Relaxed) + 1)
        };
        Ok(AsyncTask::new(Configure {
            raw: raw.clone(),
            owner: self.csv.clone(),
            options,
            generation,
            revision,
            epoch,
            existing,
            cancel: cancel.flag.clone(),
            slot: None,
            build_slot: None,
            build_temp: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    fn csv_context<Q: Query>(
        &self,
        generation: f64,
        revision: f64,
        cancel: &Cancel,
        query: Q,
    ) -> std::result::Result<AsyncTask<ReadCsv<Q>>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let raw = self.raw()?;
        if raw.document().generation() != generation {
            return Err(doc_error(DocError::Stale { current: raw.document().generation(), asked: generation }));
        }
        let state = self
            .csv
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.csv.revision == revision)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "CSV configuration was replaced"))?;
        if state.csv.locked {
            return Err(Error::new(Code::Refused, core_csv::UTF16_REASON));
        }
        if let Some(error) = state.error.lock().unwrap().as_ref() {
            return Err(Error::new(Code::Refused, error.clone()));
        }
        let charge = Reservation::new(core_csv::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(ReadCsv {
            ctx: Context {
                raw: raw.clone(),
                owner: self.csv.clone(),
                state,
                cancel: cancel.flag.clone(),
                slot: None,
                _charge: charge,
                #[cfg(feature = "test-hooks")]
                _task: hooks::Live::new(&hooks::TASKS),
            },
            query,
        }))
    }
    #[napi(ts_return_type = "Promise<CsvPage>")]
    #[allow(
        clippy::too_many_arguments,
        reason = "the native boundary validates both rectangle axes and its generation/revision/cancel owners"
    )]
    pub fn csv_page(
        &self,
        generation: f64,
        revision: f64,
        row: f64,
        rows: f64,
        column: f64,
        columns: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<PageQuery>>, Error<Code>> {
        let query = PageQuery {
            row: int("start", row)?,
            rows: count(rows, core_csv::MAX_ROWS, "rowCount")?,
            column: int("start", column)?,
            columns: count(columns, core_csv::MAX_COLUMNS, "columnCount")?,
        };
        self.csv_context(generation, revision, cancel, query)
    }
    #[napi(ts_return_type = "Promise<CsvCellPiece>")]
    pub fn csv_piece(
        &self,
        generation: f64,
        revision: f64,
        record: f64,
        column: f64,
        offset: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<PieceQuery>>, Error<Code>> {
        let query =
            PieceQuery { record: int("start", record)?, column: int("start", column)?, offset: int("offset", offset)? };
        self.csv_context(generation, revision, cancel, query)
    }
    #[napi(ts_return_type = "Promise<CsvColumnPage>")]
    pub fn csv_columns(
        &self,
        generation: f64,
        revision: f64,
        start: f64,
        n: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<ColumnsQuery>>, Error<Code>> {
        let query = ColumnsQuery { start: int("start", start)?, count: count(n, core_csv::MAX_COLUMNS, "count")? };
        self.csv_context(generation, revision, cancel, query)
    }
    #[napi(ts_return_type = "Promise<CsvLocated>")]
    pub fn csv_locate(
        &self,
        generation: f64,
        revision: f64,
        line: Option<f64>,
        offset: Option<f64>,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<LocateQuery>>, Error<Code>> {
        if line.is_some() == offset.is_some() {
            return Err(Error::new(Code::InvalidParams, "supply one Raw line or source offset"));
        }
        let query = LocateQuery {
            line: line.map(|n| int("line", n)).transpose()?,
            offset: offset.map(|n| int("offset", n)).transpose()?,
        };
        self.csv_context(generation, revision, cancel, query)
    }
    #[napi(ts_return_type = "Promise<CsvSource>")]
    pub fn csv_source(
        &self,
        generation: f64,
        revision: f64,
        record: f64,
        column: Option<f64>,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<SourceQuery>>, Error<Code>> {
        let query = SourceQuery { record: int("start", record)?, column: column.map(|n| int("start", n)).transpose()? };
        self.csv_context(generation, revision, cancel, query)
    }
}
