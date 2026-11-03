//! Bounded verified source transport for source-faithful copy and off-main parsers.
use super::*;

pub struct SourceBytes {
    raw: Arc<Raw>,
    generation: u32,
    start: u64,
    count: u64,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for SourceBytes {
    type Output = std::result::Result<Vec<u8>, DocError>;
    type JsValue = Uint8Array;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(slot(Work::Page, &store::cancelled)?);
            self.raw.document().read(self.generation, self.start, self.start + self.count)
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output.and_then(|bytes| {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(DocError::Cancelled);
            }
            self.raw.document().verified(self.generation, |_| Ok(()))?;
            Ok(bytes)
        });
        result.map(Uint8Array::new).map_err(|e| err(env, e))
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<Uint8Array>")]
    pub fn source_bytes(
        &self,
        generation: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<SourceBytes>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let start = int("offset", start)?;
        let count = int("bytes", count)?;
        if count == 0 || count > 65_536 {
            return Err(Error::new(Code::InvalidParams, "sourceBytes count must be 1–65536 bytes"));
        }
        let raw = self.raw()?;
        let size = raw.document().len();
        if start > size || count > size - start {
            return Err(Error::new(Code::InvalidParams, "sourceBytes range is outside the document"));
        }
        let charge = Reservation::new(256 << 10).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(SourceBytes {
            raw: raw.clone(),
            generation,
            start,
            count,
            cancel: cancel.flag.clone(),
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
}

#[napi(object)]
pub struct SourceLocation {
    pub line: f64,
}
/// What a source query runs on the pool's thread, given the document and the generation asked for.
type Op<T> = Box<dyn Fn(&Raw, u32) -> std::result::Result<T, DocError> + Send>;
/// A source query in a page slot (plan C1), like csv.rs's `ReadCsv`. Its result is refused if the core host cancelled
/// it or the source changed meanwhile.
pub struct SourceTask<T> {
    raw: Arc<Raw>,
    generation: u32,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    op: Op<T>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl<T: ToNapiValue + TypeName + Send + 'static> SourceTask<T> {
    fn new(
        raw: &Arc<Raw>,
        generation: u32,
        cancel: &Cancel,
        op: impl Fn(&Raw, u32) -> std::result::Result<T, DocError> + Send + 'static,
    ) -> AsyncTask<Self> {
        AsyncTask::new(SourceTask {
            raw: raw.clone(),
            generation,
            cancel: cancel.flag.clone(),
            slot: None,
            op: Box::new(op),
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        })
    }
}
impl<T: ToNapiValue + TypeName + Send + 'static> Task for SourceTask<T> {
    type Output = std::result::Result<T, DocError>;
    type JsValue = T;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(slot(Work::Page, &store::cancelled)?);
            (self.op)(&self.raw, self.generation)
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .and_then(|value| {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(DocError::Cancelled);
                }
                self.raw.document().verified(self.generation, |_| Ok(()))?;
                Ok(value)
            })
            .map_err(|e| err(env, e))
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type = "Promise<SourceLocation>")]
    pub fn source_line_at(
        &self,
        generation: f64,
        offset: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<SourceTask<SourceLocation>>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let offset = int("offset", offset)?;
        let raw = self.raw()?;
        if offset > raw.document().len() {
            return Err(Error::new(Code::InvalidParams, "source position is outside the document"));
        }
        Ok(SourceTask::new(raw, generation, cancel, move |raw, generation| {
            let line = raw
                .source_line_at(generation, offset)?
                .ok_or_else(|| DocError::Refused("The requested source position is not indexed yet".into()))?;
            Ok(SourceLocation { line: line as f64 })
        }))
    }
    #[napi(ts_return_type = "Promise<Span>")]
    pub fn source_line_range(
        &self,
        generation: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<SourceTask<Span>>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let start = int("line", start)?;
        let count = int("bytes", count)?;
        if count == 0 {
            return Err(Error::new(Code::InvalidParams, "source line count must be positive"));
        }
        Ok(SourceTask::new(self.raw()?, generation, cancel, move |raw, generation| {
            let (lines, done) = raw.lines_known();
            let end_line =
                start.checked_add(count).ok_or_else(|| DocError::Invalid("source line range overflow".into()))?;
            let first = raw
                .line_offset(generation, start)?
                .ok_or_else(|| DocError::Refused("The requested source line is not indexed yet".into()))?;
            let end = if done && end_line >= lines {
                raw.document().len()
            } else {
                raw.line_offset(generation, end_line)?
                    .ok_or_else(|| DocError::Refused("The requested source range is not indexed yet".into()))?
            };
            Ok(Span { start: first as f64, end: end as f64 })
        }))
    }
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn source_verify(
        &self,
        generation: f64,
        start: f64,
        end: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<SourceTask<bool>>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let start = int("offset", start)?;
        let end = int("offset", end)?;
        let raw = self.raw()?;
        if start > end || end > raw.document().len() {
            return Err(Error::new(Code::InvalidParams, "source verification range is outside the document"));
        }
        Ok(SourceTask::new(raw, generation, cancel, move |raw, generation| {
            raw.document().verified(generation, |store| {
                let mut at = start;
                while at < end {
                    let to = (at + 65_536).min(end);
                    store.read(at, to)?;
                    at = to;
                }
                Ok(true)
            })
        }))
    }
}
