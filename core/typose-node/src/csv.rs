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
    order: Mutex<Option<(u32, Arc<core_csv::Order>)>>,
    next_order: AtomicU32,
    sort_epoch: AtomicU64,
    find: Mutex<Option<(u32, u32, Arc<core_csv::GridFind>)>>,
    next_find: AtomicU32,
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
        self.state.lock().unwrap().as_ref().map_or(0, |state| {
            state.csv.charged()
                + state.order.lock().unwrap().as_ref().map_or(0, |(_, order)| order.charged())
                + state
                    .find
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map_or(0, |(_, order, find)| find.charged() + if *order == 0 { find.order_charged() } else { 0 })
        })
    }
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Some(state) = self.state.lock().unwrap().take() {
            state.cancel.store(true, Ordering::Relaxed);
            if let Some((_, _, find)) = state.find.lock().unwrap().take() {
                find.close();
            }
        }
    }
    fn current(&self, state: &Arc<State>) -> bool {
        !self.closed.load(Ordering::Relaxed)
            && self.state.lock().unwrap().as_ref().is_some_and(|s| Arc::ptr_eq(s, state))
    }
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
    pub done: bool,
    pub expected_columns: f64,
    pub max_columns_known: f64,
    pub metadata_done: bool,
    pub problems: Vec<CsvProblem>,
}
#[napi(object)]
pub struct CsvProblem {
    pub kind: String,
    pub count: f64,
    pub first: Span,
    pub source_record: Option<f64>,
    pub source_line: Option<f64>,
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
    pub span: Span,
    pub piece_span: Span,
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
    pub span: Span,
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
    pub span: Option<Span>,
    pub column: Option<f64>,
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
        done: index.done,
        expected_columns: index.expected_columns as f64,
        max_columns_known: index.max_columns as f64,
        metadata_done: index.metadata.done,
        problems: index
            .metadata
            .problems
            .iter()
            .map(|problem| CsvProblem {
                kind: problem.kind.into(),
                count: problem.count as f64,
                first: span(problem.first),
                source_record: problem.record.map(|record| record as f64),
                source_line: problem.record.map(|_| problem.line as f64),
            })
            .collect(),
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
            Ok(Arc::new(State {
                csv,
                cancel: Arc::new(AtomicBool::new(false)),
                error: Mutex::new(None),
                order: Mutex::new(None),
                next_order: AtomicU32::new(0),
                sort_epoch: AtomicU64::new(0),
                find: Mutex::new(None),
                next_find: AtomicU32::new(0),
            }))
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
                if let Some((_, _, find)) = old.find.lock().unwrap().take() {
                    find.close();
                }
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
    fn check(&self, _ctx: &Context) -> std::result::Result<(), DocError> {
        Ok(())
    }
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
            self.query.check(&self.ctx)?;
            self.query.run(&self.ctx)
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output.and_then(|out| {
            self.ctx.check()?;
            self.query.check(&self.ctx)?;
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
    order: Option<(u32, Arc<core_csv::Order>)>,
}
impl Query for PageQuery {
    type Output = core_csv::Page;
    type JsValue = CsvPage;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        c.state.csv.ordered_page(
            c.raw.document(),
            self.row,
            self.rows,
            self.column,
            self.columns,
            self.order.as_ref().map(|(_, o)| &**o),
        )
    }
    fn check(&self, c: &Context) -> std::result::Result<(), DocError> {
        if let Some((id, _)) = &self.order {
            check_order(&c.state, *id)?;
        }
        Ok(())
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
    offset: Option<u64>,
}
impl Query for PieceQuery {
    type Output = core_csv::Piece;
    type JsValue = CsvCellPiece;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        c.state.csv.piece(c.raw.document(), self.record, self.column, self.offset)
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
        let (width, header_fields, metadata_done) = {
            let index = c.state.csv.index.read().unwrap();
            (index.max_columns, index.expected_columns, index.metadata.done)
        };
        let mut columns = Vec::with_capacity(self.count);
        for column in self.start..self.start.saturating_add(self.count as u64).min(width) {
            if store::cancelled() {
                return Err(DocError::Cancelled);
            }
            // A ragged row's extra fields have no header cell to name them.
            let (name, name_more) = if c.state.csv.header && column < header_fields {
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
            let sampled = c.state.csv.index.read().unwrap().metadata.columns.get(column as usize).cloned();
            columns.push(CsvColumn {
                column: column as f64,
                name,
                name_more,
                kind: sampled
                    .as_ref()
                    .map(|column| column.kind.clone())
                    .filter(|kind| !kind.is_empty())
                    .unwrap_or_else(|| "text".into()),
                width_units: sampled.as_ref().map_or(width_units, |column| width_units.max(column.width_units as f64)),
                pills: sampled.and_then(|column| column.pills),
            });
        }
        let next = self.start + columns.len() as u64;
        Ok(CsvColumnPage { columns, next_column: (next < width).then_some(next as f64), metadata_done })
    }
    fn convert(&self, p: Self::Output) -> CsvColumnPage {
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
            order: None,
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
        let query = PieceQuery {
            record: int("start", record)?,
            column: int("start", column)?,
            offset: Some(int("offset", offset)?),
        };
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
}

#[napi(object)]
pub struct CsvOrderInfo {
    pub id: u32,
    pub rows: f64,
    pub column: f64,
    pub direction: String,
}
#[napi(object)]
pub struct CsvOrderLocated {
    pub data_row: f64,
}
fn check_order(state: &State, id: u32) -> std::result::Result<(), DocError> {
    let held = state.order.lock().unwrap();
    if held.as_ref().map_or(id == 0, |(current, _)| *current == id) { Ok(()) } else { Err(stale(id)) }
}
fn get_order(state: &State, id: u32, raw: &Raw) -> std::result::Result<Arc<core_csv::Order>, DocError> {
    check_order(state, id)?;
    let held = state.order.lock().unwrap();
    if let Some((_, order)) = &*held {
        Ok(order.clone())
    } else {
        drop(held);
        Ok(Arc::new(state.csv.order(raw.document(), 0, 0)?))
    }
}
pub struct SortQuery {
    state: Arc<State>,
    id: u32,
    epoch: u64,
    column: u64,
    direction: i32,
}
impl Query for SortQuery {
    type Output = core_csv::Order;
    type JsValue = CsvOrderInfo;
    fn check(&self, _: &Context) -> std::result::Result<(), DocError> {
        if self.state.sort_epoch.load(Ordering::Relaxed) == self.epoch { Ok(()) } else { Err(stale(self.id)) }
    }
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        c.state.csv.order(c.raw.document(), self.column, self.direction)
    }
    fn convert(&self, order: Self::Output) -> Self::JsValue {
        let rows = order.rows;
        if let Some((_, _, find)) = self.state.find.lock().unwrap().take() {
            find.close();
        }
        self.state.order.lock().unwrap().replace((self.id, Arc::new(order)));
        CsvOrderInfo {
            id: self.id,
            rows: rows as f64,
            column: self.column as f64,
            direction: match self.direction {
                -1 => "desc",
                0 => "none",
                _ => "asc",
            }
            .into(),
        }
    }
}
pub struct OrderLocateQuery {
    id: u32,
    record: u64,
}
impl Query for OrderLocateQuery {
    type Output = CsvOrderLocated;
    type JsValue = CsvOrderLocated;
    fn check(&self, c: &Context) -> std::result::Result<(), DocError> {
        check_order(&c.state, self.id)
    }
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        let order = get_order(&c.state, self.id, &c.raw)?;
        let row =
            order.locate(self.record).ok_or_else(|| DocError::Invalid("source record is not a data row".into()))?;
        Ok(CsvOrderLocated { data_row: row as f64 })
    }
    fn convert(&self, value: Self::Output) -> Self::JsValue {
        value
    }
}
pub struct CellQuery {
    record: u64,
    column: u64,
}
impl Query for CellQuery {
    type Output = Option<core_csv::Piece>;
    type JsValue = CsvCell;
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        match c.state.csv.row(c.raw.document(), self.record)? {
            Some(row) if self.column < row.fields => {
                c.state.csv.piece(c.raw.document(), self.record, self.column, None).map(Some)
            }
            Some(_) => Ok(None),
            None => Err(DocError::Invalid("source record is not indexed".into())),
        }
    }
    fn convert(&self, value: Self::Output) -> Self::JsValue {
        CsvCell { column: self.column as f64, value: value.map(piece) }
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<CsvOrderInfo>")]
    pub fn csv_sort(
        &self,
        generation: f64,
        revision: f64,
        column: f64,
        direction: String,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<SortQuery>>, Error<Code>> {
        let asked_generation = int("gen", generation)? as u32;
        let current = self.raw()?.document().generation();
        if current != asked_generation {
            return Err(doc_error(DocError::Stale { current, asked: asked_generation }));
        }
        let revision_id = int("gen", revision)? as u32;
        let state = self
            .csv
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.csv.revision == revision_id)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "CSV configuration replaced"))?;
        let column = int("start", column)?;
        let direction = match direction.as_str() {
            "asc" => 1,
            "desc" => -1,
            "none" => 0,
            _ => return Err(Error::new(Code::InvalidParams, "sort direction must be asc, desc or none")),
        };
        let id = state
            .next_order
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::new(Code::Refused, "sort identities exhausted"))?
            + 1;
        let epoch = state.sort_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        self.csv_context(generation, revision, cancel, SortQuery { state, id, epoch, column, direction })
    }
    #[napi(ts_return_type = "Promise<CsvPage>")]
    #[allow(clippy::too_many_arguments, reason = "native ordered rectangle validates both axes and exact owners")]
    pub fn csv_ordered_page(
        &self,
        generation: f64,
        revision: f64,
        order: f64,
        row: f64,
        rows: f64,
        column: f64,
        columns: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<PageQuery>>, Error<Code>> {
        let id = order_id(order)?;
        let revision_id = int("gen", revision)? as u32;
        let raw = self.raw()?;
        let state = self
            .csv
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.csv.revision == revision_id)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "CSV configuration replaced"))?;
        let order = get_order(&state, id, raw).map_err(doc_error)?;
        self.csv_context(
            generation,
            revision,
            cancel,
            PageQuery {
                row: int("start", row)?,
                rows: count(rows, core_csv::MAX_ROWS, "rowCount")?,
                column: int("start", column)?,
                columns: count(columns, core_csv::MAX_COLUMNS, "columnCount")?,
                order: Some((id, order)),
            },
        )
    }
    #[napi(ts_return_type = "Promise<CsvOrderLocated>")]
    pub fn csv_order_locate(
        &self,
        generation: f64,
        revision: f64,
        order: f64,
        record: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<OrderLocateQuery>>, Error<Code>> {
        self.csv_context(
            generation,
            revision,
            cancel,
            OrderLocateQuery { id: order_id(order)?, record: int("start", record)? },
        )
    }
    #[napi(ts_return_type = "Promise<CsvCell>")]
    pub fn csv_cell(
        &self,
        generation: f64,
        revision: f64,
        record: f64,
        column: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<CellQuery>>, Error<Code>> {
        self.csv_context(
            generation,
            revision,
            cancel,
            CellQuery { record: int("start", record)?, column: int("start", column)? },
        )
    }
}

#[napi(object)]
pub struct CsvFindHit {
    pub data_row: f64,
    pub source_record: f64,
    pub column: f64,
    pub start: f64,
    pub end: f64,
    pub text: Option<String>,
    pub match_start: Option<u32>,
    pub match_end: Option<u32>,
}
#[napi(object)]
pub struct CsvFindPage {
    pub count: f64,
    pub complete: bool,
    pub hits: Vec<CsvFindHit>,
    pub hit: Option<CsvFindHit>,
    pub ordinal: Option<f64>,
    pub wrapped: bool,
}
fn grid_hit(h: core_csv::GridHit) -> CsvFindHit {
    CsvFindHit {
        data_row: h.data_row as f64,
        source_record: h.record as f64,
        column: h.column as f64,
        start: h.start as f64,
        end: h.end as f64,
        text: None,
        match_start: None,
        match_end: None,
    }
}
fn grid_excerpt(c: &Context, h: core_csv::GridHit) -> std::result::Result<CsvFindHit, DocError> {
    let mut result = grid_hit(h);
    let mut text = String::with_capacity(4096);
    let (mut matched, mut context) = (0, 0);
    let mut offset = h.start;
    for _ in 0..4 {
        let piece = c.state.csv.piece(c.raw.document(), h.record, h.column, Some(offset))?;
        let mut units = 0;
        for ch in piece.text.chars() {
            if piece.map.start_byte(units) < h.end {
                matched += ch.len_utf16() as u32;
            } else {
                context += ch.len_utf16();
            }
            units += ch.len_utf16() as u32;
            text.push(ch);
            if context >= 256 {
                break;
            }
        }
        if context >= 256 {
            break;
        }
        let Some(next) = piece.next else {
            break;
        };
        offset = next;
    }
    result.text = Some(text);
    result.match_start = Some(0);
    result.match_end = Some(matched);
    Ok(result)
}
pub struct GridFindQuery {
    id: u32,
    order: u32,
    search: Arc<core_csv::GridFind>,
    seek: bool,
    from: Option<core_csv::GridHit>,
    previous: bool,
}
impl Query for GridFindQuery {
    type Output = CsvFindPage;
    type JsValue = CsvFindPage;
    fn check(&self, c: &Context) -> std::result::Result<(), DocError> {
        check_order(&c.state, self.order)?;
        if c.state
            .find
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(id, _, search)| *id == self.id && Arc::ptr_eq(search, &self.search))
        {
            Ok(())
        } else {
            Err(stale(self.id))
        }
    }
    fn run(&self, c: &Context) -> std::result::Result<Self::Output, DocError> {
        if self.seek {
            let (hit, wrapped, ordinal) = self.search.seek(&c.state.csv, c.raw.document(), self.from, self.previous)?;
            Ok(CsvFindPage {
                count: 0.,
                complete: false,
                hits: Vec::new(),
                hit: hit.map(|h| grid_excerpt(c, h)).transpose()?,
                ordinal: ordinal.map(|n| n as f64),
                wrapped,
            })
        } else {
            let p = self.search.scan(&c.state.csv, c.raw.document())?;
            Ok(CsvFindPage {
                count: p.count as f64,
                complete: p.complete,
                hits: p.hits.into_iter().map(grid_hit).collect(),
                hit: None,
                ordinal: None,
                wrapped: false,
            })
        }
    }
    fn convert(&self, result: Self::Output) -> Self::JsValue {
        result
    }
}
#[napi]
impl Doc {
    #[napi]
    pub fn csv_order_close(
        &self,
        generation: f64,
        revision: f64,
        order: f64,
    ) -> std::result::Result<bool, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let order = order_id(order)?;
        let raw = self.raw()?;
        if raw.document().generation() != generation {
            return Ok(false);
        }
        let state = self.csv.state.lock().unwrap().as_ref().filter(|s| s.csv.revision == revision).cloned();
        let Some(state) = state else {
            return Ok(false);
        };
        if check_order(&state, order).is_err() {
            return Ok(false);
        }
        state.sort_epoch.fetch_add(1, Ordering::Relaxed);
        state.order.lock().unwrap().take();
        if let Some((_, _, find)) = state.find.lock().unwrap().take() {
            find.close();
        }
        Ok(true)
    }
    #[napi]
    pub fn csv_find_start(
        &self,
        generation: f64,
        revision: f64,
        order: f64,
        query: String,
        match_case: bool,
    ) -> std::result::Result<u32, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let order_id = order_id(order)?;
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
            .ok_or_else(|| Error::new(Code::Stale, "CSV configuration replaced"))?;
        if state.csv.locked {
            return Err(Error::new(Code::Refused, core_csv::UTF16_REASON));
        }
        let order = get_order(&state, order_id, raw).map_err(doc_error)?;
        let search = Arc::new(core_csv::GridFind::new(&state.csv, order, &query, match_case).map_err(doc_error)?);
        let id = state
            .next_find
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::new(Code::Refused, "Grid Find identities exhausted"))?
            + 1;
        if let Some((_, _, old)) = state.find.lock().unwrap().replace((id, order_id, search)) {
            old.close();
        }
        Ok(id)
    }
    fn grid_find_query(
        &self,
        revision: f64,
        id: f64,
        seek: bool,
        from: Option<CsvFindHit>,
        previous: bool,
    ) -> std::result::Result<GridFindQuery, Error<Code>> {
        let revision = int("gen", revision)? as u32;
        let id = int("gen", id)? as u32;
        let state = self
            .csv
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.csv.revision == revision)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "CSV configuration replaced"))?;
        let held = state.find.lock().unwrap();
        let (_, order, search) = held
            .as_ref()
            .filter(|(current, _, _)| *current == id)
            .ok_or_else(|| Error::new(Code::Stale, "Grid Find query replaced"))?;
        let from = from
            .map(|h| {
                Ok::<_, Error<Code>>(core_csv::GridHit {
                    data_row: int("start", h.data_row)?,
                    record: int("start", h.source_record)?,
                    column: int("start", h.column)?,
                    start: int("offset", h.start)?,
                    end: int("offset", h.end)?,
                    within_row: 0,
                })
            })
            .transpose()?;
        Ok(GridFindQuery { id, order: *order, search: search.clone(), seek, from, previous })
    }
    #[napi(ts_return_type = "Promise<CsvFindPage>")]
    pub fn csv_find_scan(
        &self,
        generation: f64,
        revision: f64,
        id: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<GridFindQuery>>, Error<Code>> {
        self.csv_context(generation, revision, cancel, self.grid_find_query(revision, id, false, None, false)?)
    }
    #[napi(ts_return_type = "Promise<CsvFindPage>")]
    #[allow(
        clippy::too_many_arguments,
        reason = "Grid Find validates generation, CSV/query identities and navigation locator"
    )]
    pub fn csv_find_seek(
        &self,
        generation: f64,
        revision: f64,
        id: f64,
        from: Option<CsvFindHit>,
        previous: bool,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<ReadCsv<GridFindQuery>>, Error<Code>> {
        self.csv_context(generation, revision, cancel, self.grid_find_query(revision, id, true, from, previous)?)
    }
    #[napi]
    pub fn csv_find_close(&self, generation: f64, revision: f64, id: f64) -> std::result::Result<bool, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let revision = int("gen", revision)? as u32;
        let id = int("gen", id)? as u32;
        let state = self
            .csv
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.csv.revision == revision && s.csv.generation == generation)
            .cloned();
        let Some(state) = state else {
            return Ok(false);
        };
        let mut held = state.find.lock().unwrap();
        if held.as_ref().is_some_and(|(current, _, _)| *current == id) {
            held.take().unwrap().2.close();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
fn order_id(value: f64) -> std::result::Result<u32, Error<Code>> {
    u32::try_from(int("start", value)?).map_err(|_| Error::new(Code::InvalidParams, "order id exceeds u32"))
}
