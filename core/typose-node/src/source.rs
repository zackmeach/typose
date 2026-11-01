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
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
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
        result.map(Uint8Array::new).map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
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
pub struct SourceLineRange {
    pub start: f64,
    pub end: f64,
}

#[napi(object)]
pub struct SourceLocation { pub line: f64 }
pub struct Location {
    raw: Arc<Raw>, generation: u32, offset: u64, cancel: Arc<AtomicBool>, slot: Option<Slot>,
    #[cfg(feature="test-hooks")] _task: hooks::Live,
}
impl Task for Location {
    type Output = std::result::Result<SourceLocation, DocError>;
    type JsValue = SourceLocation;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e { NoSlot::Cancelled => DocError::Cancelled, NoSlot::Budget(e) => DocError::Memory(e) })?);
            let line = self.raw.source_line_at(self.generation, self.offset)?.ok_or_else(|| DocError::Refused("The requested source position is not indexed yet".into()))?;
            Ok(SourceLocation { line: line as f64 })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output.and_then(|location| { if self.cancel.load(Ordering::Relaxed) { return Err(DocError::Cancelled); } self.raw.document().verified(self.generation, |_| Ok(()))?; Ok(location) })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
pub struct LineRange {
    raw: Arc<Raw>,
    generation: u32,
    start: u64,
    count: u64,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for LineRange {
    type Output = std::result::Result<SourceLineRange, DocError>;
    type JsValue = SourceLineRange;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            let (lines, done) = self.raw.lines_known();
            let end_line = self
                .start
                .checked_add(self.count)
                .ok_or_else(|| DocError::Invalid("source line range overflow".into()))?;
            let start = self
                .raw
                .line_offset(self.generation, self.start)?
                .ok_or_else(|| DocError::Refused("The requested source line is not indexed yet".into()))?;
            let end = if done && end_line >= lines {
                self.raw.document().len()
            } else {
                self.raw
                    .line_offset(self.generation, end_line)?
                    .ok_or_else(|| DocError::Refused("The requested source range is not indexed yet".into()))?
            };
            Ok(SourceLineRange { start: start as f64, end: end as f64 })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .and_then(|range| {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(DocError::Cancelled);
                }
                self.raw.document().verified(self.generation, |_| Ok(()))?;
                Ok(range)
            })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
pub struct Verify {
    raw: Arc<Raw>,
    generation: u32,
    start: u64,
    end: u64,
    cancel: Arc<AtomicBool>,
    slot: Option<Slot>,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
impl Task for Verify {
    type Output = std::result::Result<bool, DocError>;
    type JsValue = bool;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(budget::slot(Work::Page, &store::cancelled).map_err(|e| match e {
                NoSlot::Cancelled => DocError::Cancelled,
                NoSlot::Budget(e) => DocError::Memory(e),
            })?);
            self.raw.document().verified(self.generation, |store| {
                let mut at = self.start;
                while at < self.end {
                    let end = (at + 65_536).min(self.end);
                    store.read(at, end)?;
                    at = end;
                }
                Ok(true)
            })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .and_then(|result| {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(DocError::Cancelled);
                }
                self.raw.document().verified(self.generation, |_| Ok(()))?;
                Ok(result)
            })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))
    }
}
#[napi]
impl Doc {
    #[napi(ts_return_type="Promise<SourceLocation>")]
    pub fn source_line_at(&self, generation: f64, offset: f64, cancel: &Cancel) -> std::result::Result<AsyncTask<Location>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let offset = int("offset", offset)?;
        let raw = self.raw()?;
        if offset > raw.document().len() { return Err(Error::new(Code::InvalidParams, "source position is outside the document")); }
        Ok(AsyncTask::new(Location { raw: raw.clone(), generation, offset, cancel: cancel.flag.clone(), slot: None, #[cfg(feature="test-hooks")] _task: hooks::Live::new(&hooks::TASKS) }))
    }
    #[napi(ts_return_type = "Promise<SourceLineRange>")]
    pub fn source_line_range(
        &self,
        generation: f64,
        start: f64,
        count: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<LineRange>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let start = int("line", start)?;
        let count = int("bytes", count)?;
        if count == 0 {
            return Err(Error::new(Code::InvalidParams, "source line count must be positive"));
        }
        Ok(AsyncTask::new(LineRange {
            raw: self.raw()?.clone(),
            generation,
            start,
            count,
            cancel: cancel.flag.clone(),
            slot: None,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn source_verify(
        &self,
        generation: f64,
        start: f64,
        end: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<Verify>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let start = int("offset", start)?;
        let end = int("offset", end)?;
        let raw = self.raw()?;
        if start > end || end > raw.document().len() {
            return Err(Error::new(Code::InvalidParams, "source verification range is outside the document"));
        }
        Ok(AsyncTask::new(Verify {
            raw: raw.clone(),
            generation,
            start,
            end,
            cancel: cancel.flag.clone(),
            slot: None,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
}
