//! Exact-generation source Find owners and bounded native transport.
use super::*;
use std::sync::atomic::AtomicU32;
use typose_core::find as core_find;

pub(super) struct Entry {
    id: u32,
    source: core_find::Source,
}
#[derive(Default)]
pub(super) struct Owner {
    state: Mutex<Option<Arc<Entry>>>,
    next: AtomicU32,
}
impl Owner {
    pub(super) fn close(&self) {
        if let Some(entry) = self.state.lock().unwrap().take() {
            entry.source.close();
        }
    }
    #[cfg(feature = "test-hooks")]
    pub(super) fn charged(&self) -> u64 {
        self.state.lock().unwrap().as_ref().map_or(0, |e| e.source.charged())
    }
    fn current(&self, entry: &Arc<Entry>) -> bool {
        self.state.lock().unwrap().as_ref().is_some_and(|e| Arc::ptr_eq(e, entry))
    }
}
#[napi(object)]
pub struct SourceHit {
    pub start: f64,
    pub end: f64,
    pub line: f64,
    pub line_start: f64,
    pub text: String,
    pub map: WireMap,
    pub match_start: u32,
    pub match_end: u32,
}
#[napi(object)]
pub struct SourceFindPage {
    pub count: f64,
    pub complete: bool,
    pub hits: Vec<SourceHit>,
    pub hit: Option<SourceHit>,
    pub wrapped: bool,
    pub ordinal: Option<f64>,
}
#[napi(object)]
pub struct SourceFindSeek {
    pub hit: Option<SourceHit>,
    pub wrapped: bool,
    pub ordinal: Option<f64>,
}
fn hit(raw: &Raw, generation: u32, h: core_find::Hit) -> std::result::Result<SourceHit, DocError> {
    let (slice, units) = core_find::snippet(raw.document(), generation, raw.source_encoding(), h)?;
    Ok(SourceHit {
        start: h.start as f64,
        end: h.end as f64,
        line: h.line as f64,
        line_start: h.line_start as f64,
        text: slice.text,
        map: wire(&slice.map),
        match_start: 0,
        match_end: units,
    })
}
enum Want {
    Scan,
    Seek { from: Option<u64>, previous: bool },
}
pub struct FindTask {
    raw: Arc<Raw>,
    owner: Arc<Owner>,
    entry: Arc<Entry>,
    cancel: Arc<AtomicBool>,
    want: Want,
    slot: Option<Slot>,
    _charge: Reservation,
    #[cfg(feature = "test-hooks")]
    _task: hooks::Live,
}
pub struct Output {
    page: SourceFindPage,
    seek: SourceFindSeek,
}
impl FindTask {
    fn check(&self) -> std::result::Result<(), DocError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(DocError::Cancelled);
        }
        if !self.owner.current(&self.entry) {
            return Err(DocError::Stale { current: 0, asked: self.entry.id });
        }
        self.raw.document().verified(self.entry.source.generation, |_| Ok(()))
    }
}
impl Task for FindTask {
    type Output = std::result::Result<Output, DocError>;
    type JsValue = SourceFindPage;
    fn compute(&mut self) -> Result<Self::Output> {
        let flag = self.cancel.clone();
        Ok(cancellable(&flag, || {
            self.slot = Some(slot(Work::Page, &store::cancelled)?);
            self.check()?;
            let mut page = SourceFindPage {
                count: 0.,
                complete: false,
                hits: Vec::new(),
                hit: None,
                wrapped: false,
                ordinal: None,
            };
            let mut seek = SourceFindSeek { hit: None, wrapped: false, ordinal: None };
            match self.want {
                Want::Scan => {
                    let p = self.entry.source.scan(self.raw.document(), self.raw.source_encoding())?;
                    page.count = p.count as f64;
                    page.complete = p.complete;
                    let mut wire = 1024;
                    for h in p.hits {
                        let h = hit(&self.raw, self.entry.source.generation, h)?;
                        let cost = 1024 + 6 * h.text.encode_utf16().count() + 24 * h.map.points.len();
                        if wire + cost > 256 << 10 {
                            break;
                        }
                        wire += cost;
                        page.hits.push(h);
                    }
                }
                Want::Seek { from, previous } => {
                    let (h, wrapped) =
                        self.entry.source.seek(self.raw.document(), self.raw.source_encoding(), from, previous)?;
                    seek = SourceFindSeek {
                        ordinal: h.map(|h| h.ordinal as f64),
                        hit: h.map(|h| hit(&self.raw, self.entry.source.generation, h)).transpose()?,
                        wrapped,
                    };
                }
            }
            Ok(Output { page, seek })
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let result = output
            .and_then(|out| {
                self.check()?;
                Ok(out)
            })
            .map_err(|e| Error::from(JsError::from(doc_error(e)).into_unknown(env)))?;
        let mut page = result.page;
        page.hit = result.seek.hit;
        page.wrapped = result.seek.wrapped;
        page.ordinal = result.seek.ordinal;
        Ok(page)
    }
}
#[napi]
impl Doc {
    #[napi]
    pub fn source_find_start(
        &self,
        generation: f64,
        query: String,
        match_case: bool,
    ) -> std::result::Result<u32, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let raw = self.raw()?;
        if raw.document().generation() != generation {
            return Err(doc_error(DocError::Stale { current: raw.document().generation(), asked: generation }));
        }
        let source = core_find::Source::new(generation, &query, match_case, raw.document().len()).map_err(doc_error)?;
        let id = self
            .find
            .next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::new(Code::Refused, "Find identities exhausted"))?
            + 1;
        let entry = Arc::new(Entry { id, source });
        if let Some(old) = self.find.state.lock().unwrap().replace(entry) {
            old.source.close();
        }
        Ok(id)
    }
    fn source_find_task(
        &self,
        generation: f64,
        id: f64,
        cancel: &Cancel,
        want: Want,
    ) -> std::result::Result<AsyncTask<FindTask>, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let id = int("gen", id)? as u32;
        let raw = self.raw()?;
        let entry = self
            .find
            .state
            .lock()
            .unwrap()
            .as_ref()
            .filter(|e| e.id == id && e.source.generation == generation)
            .cloned()
            .ok_or_else(|| Error::new(Code::Stale, "Find query was replaced"))?;
        let charge = Reservation::new(core_find::TEMP_BYTES).map_err(|e| doc_error(DocError::Memory(e)))?;
        Ok(AsyncTask::new(FindTask {
            raw: raw.clone(),
            owner: self.find.clone(),
            entry,
            cancel: cancel.flag.clone(),
            want,
            slot: None,
            _charge: charge,
            #[cfg(feature = "test-hooks")]
            _task: hooks::Live::new(&hooks::TASKS),
        }))
    }
    #[napi(ts_return_type = "Promise<SourceFindPage>")]
    pub fn source_find_scan(
        &self,
        generation: f64,
        id: f64,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<FindTask>, Error<Code>> {
        self.source_find_task(generation, id, cancel, Want::Scan)
    }
    #[napi(ts_return_type = "Promise<SourceFindSeek>")]
    pub fn source_find_seek(
        &self,
        generation: f64,
        id: f64,
        from: Option<f64>,
        previous: bool,
        cancel: &Cancel,
    ) -> std::result::Result<AsyncTask<FindTask>, Error<Code>> {
        self.source_find_task(
            generation,
            id,
            cancel,
            Want::Seek { from: from.map(|n| int("offset", n)).transpose()?, previous },
        )
    }
    #[napi]
    pub fn source_find_close(&self, generation: f64, id: f64) -> std::result::Result<bool, Error<Code>> {
        let generation = int("gen", generation)? as u32;
        let id = int("gen", id)? as u32;
        let mut held = self.find.state.lock().unwrap();
        if held.as_ref().is_some_and(|e| e.id == id && e.source.generation == generation) {
            held.take().unwrap().source.close();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
