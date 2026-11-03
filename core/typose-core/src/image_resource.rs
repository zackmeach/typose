//! Charged, generation-bound local image resources. Only canonical PNG bytes leave this module.
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::budget::Reservation;
use crate::doc::{DocError, Document, FileId, MAX_SAFE};
use crate::images::{self, CanonicalImage, ImageError, MAX_SOURCE};
use crate::local::{LocalError, LocalRoute};

pub const CHUNK: usize = 256 << 10;
const STATE_BYTES: u64 = 4096; // fixed two-slot state, Mutex, Arc and allocator overhead
static CODEC_BUSY: AtomicBool = AtomicBool::new(false);

fn local_error(error: LocalError) -> DocError {
    match error {
        LocalError::Refused(why) => DocError::Refused(why.into()),
        LocalError::Io(error) => DocError::Io(error),
        LocalError::Memory(error) => DocError::Memory(error),
    }
}

fn image_error(error: ImageError) -> DocError {
    match error {
        ImageError::Refused(why) => DocError::Refused(why.into()),
        ImageError::Cancelled => DocError::Cancelled,
        ImageError::Memory(error) => DocError::Memory(error),
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<(), DocError> {
    if cancel.load(Ordering::Relaxed) { Err(DocError::Cancelled) } else { Ok(()) }
}

/// No pathname fallback. This function is also used before returning canonical chunks.
pub fn check_source(source: &Document, generation: u32) -> Result<(), DocError> {
    source.check_local_source(generation)
}

/// Holds the input buffer and its charge together. Read once from the inherited route, with bounded capacity.
struct Snapshot {
    route: LocalRoute,
    file: File,
    id: FileId,
    bytes: Vec<u8>,
    #[cfg(feature = "test-hooks")]
    _handle: crate::hooks::Live,
    // Last: bytes and the held target handle drop before their memory charge.
    _charge: Reservation,
}

impl Snapshot {
    fn read(source: &Document, generation: u32, target: &str, cancel: &AtomicBool) -> Result<Self, DocError> {
        cancelled(cancel)?;
        // Only the held capability, any extension: the codec, not a pathname extension, identifies the format.
        let route = source.link_path(generation, target)?;
        let mut file = route.open().map_err(local_error)?;
        #[cfg(feature = "test-hooks")]
        let handle = crate::hooks::Live::new(&crate::hooks::HANDLES);
        let meta = file.metadata().map_err(DocError::Io)?;
        if !meta.is_file() {
            return Err(DocError::Refused("local image must be a regular file of at most 8 MiB".into()));
        }
        let id = FileId::of_file(&file).map_err(DocError::Io)?;
        if id.size > MAX_SOURCE as u64 {
            return Err(DocError::Refused("local image must be a regular file of at most 8 MiB".into()));
        }
        let charge = Reservation::new(MAX_SOURCE as u64).map_err(DocError::Memory)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(MAX_SOURCE).map_err(|_| DocError::Refused("image input allocation failed".into()))?;
        bytes.resize(id.size as usize, 0);
        for chunk in bytes.chunks_mut(CHUNK) {
            cancelled(cancel)?;
            #[cfg(feature = "test-hooks")]
            crate::hooks::read_delay();
            file.read_exact(chunk).map_err(|error| DocError::Refused(format!("local image read failed: {error}")))?;
        }
        let snapshot = Self {
            route,
            file,
            id,
            bytes,
            #[cfg(feature = "test-hooks")]
            _handle: handle,
            _charge: charge,
        };
        snapshot.verify(source, generation, cancel)?;
        Ok(snapshot)
    }

    fn verify(&self, source: &Document, generation: u32, cancel: &AtomicBool) -> Result<(), DocError> {
        cancelled(cancel)?;
        if self.bytes.len() as u64 != self.id.size {
            return Err(DocError::Refused("local image snapshot does not cover its recorded file size".into()));
        }
        // Source failure remains Frozen. Every target failure remains a refusal, never a source banner.
        source.check_local_source(generation)?;
        let current = self.route.open().map_err(local_error)?;
        let same = self.route.same_file(&self.file, &current).map_err(local_error)?;
        let current_id = FileId::of_file(&current).map_err(DocError::Io)?;
        let held_id = FileId::of_file(&self.file).map_err(DocError::Io)?;
        if !same || self.id != current_id || self.id != held_id {
            return Err(DocError::Refused("local image changed while reading or decoding".into()));
        }
        Ok(())
    }
}

/// Serializes the input snapshot and codec, not the later canonical-byte downloads.
struct CodecPermit;

impl CodecPermit {
    fn take(cancel: &AtomicBool) -> Result<Self, DocError> {
        loop {
            cancelled(cancel)?;
            if CODEC_BUSY.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for CodecPermit {
    fn drop(&mut self) {
        CODEC_BUSY.store(false, Ordering::Release);
    }
}

pub fn prepare(
    source: &Document,
    generation: u32,
    target: &str,
    cancel: &AtomicBool,
) -> Result<CanonicalImage, DocError> {
    let permit = CodecPermit::take(cancel)?;
    let snapshot = Snapshot::read(source, generation, target, cancel)?;
    let image = images::decode(&snapshot.bytes, cancel).map_err(image_error)?;
    snapshot.verify(source, generation, cancel)?;
    drop(snapshot); // original bytes, input charge, target handle and route gone before metadata can leave
    drop(permit);
    cancelled(cancel)?;
    Ok(image)
}

#[derive(Clone, Copy, Debug)]
pub struct Metadata {
    pub id: u64,
    pub width: u32,
    pub height: u32,
    pub encoded_bytes: u32,
    pub pixel_bytes: u32,
}

enum Entry {
    Pending { id: u64, cancel: Arc<AtomicBool> },
    Ready { id: u64, image: CanonicalImage },
}

impl Entry {
    fn id(&self) -> u64 {
        match self {
            Self::Pending { id, .. } | Self::Ready { id, .. } => *id,
        }
    }
}

struct Entries {
    live: bool,
    next: u64,
    slots: [Option<Entry>; 2],
}

/// One generation's fixed-size resource owner. Retain the complete CanonicalImage, including its Reservation.
pub struct Resources {
    generation: u32,
    entries: Mutex<Entries>,
    // Last: slot contents/Arc/Mutex allocation remain charged until released.
    charge: Reservation,
}

impl Resources {
    pub fn new(generation: u32) -> Result<Arc<Self>, DocError> {
        let charge = Reservation::new(STATE_BYTES).map_err(DocError::Memory)?;
        Ok(Arc::new(Self {
            generation,
            entries: Mutex::new(Entries { live: true, next: 1, slots: [None, None] }),
            charge,
        }))
    }

    pub fn reserve(self: &Arc<Self>, cancel: Arc<AtomicBool>) -> Result<Pending, DocError> {
        cancelled(&cancel)?;
        let mut entries = self.entries.lock().unwrap();
        if !entries.live {
            return Err(DocError::Cancelled);
        }
        let slot = entries.slots.iter().position(Option::is_none).ok_or_else(|| {
            DocError::Refused("release a local image before preparing another (two slots per document)".into())
        })?;
        let id = entries.next;
        if id > MAX_SAFE {
            return Err(DocError::Refused("local image ids exhausted; Reload the document".into()));
        }
        entries.next += 1;
        entries.slots[slot] = Some(Entry::Pending { id, cancel });
        Ok(Pending { state: Arc::clone(self), id, published: false })
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn contains(&self, id: u64) -> bool {
        let entries = self.entries.lock().unwrap();
        entries.live
            && entries
                .slots
                .iter()
                .any(|entry| matches!(entry, Some(Entry::Ready { id: current, .. }) if *current == id))
    }

    /// Caller holds a Work::Page slot before this bounded copy, through NAPI resolve.
    pub fn chunk(&self, id: u64, offset: usize) -> Result<Vec<u8>, DocError> {
        if !offset.is_multiple_of(CHUNK) {
            return Err(DocError::Invalid("image offset must be aligned to 256 KiB".into()));
        }
        let entries = self.entries.lock().unwrap();
        if !entries.live {
            return Err(DocError::Cancelled);
        }
        let image = entries
            .slots
            .iter()
            .find_map(|entry| match entry {
                Some(Entry::Ready { id: current, image }) if *current == id => Some(image),
                _ => None,
            })
            .ok_or_else(|| DocError::Refused("the image resource was released".into()))?;
        let bytes = image.bytes();
        if offset > bytes.len() {
            return Err(DocError::Invalid("image offset is past the encoded bytes".into()));
        }
        Ok(bytes[offset..bytes.len().min(offset + CHUNK)].to_vec())
    }

    pub fn release(&self, id: u64) -> bool {
        let mut entries = self.entries.lock().unwrap();
        if let Some(slot) = entries.slots.iter_mut().find(|entry| entry.as_ref().is_some_and(|entry| entry.id() == id))
        {
            if let Some(Entry::Pending { cancel, .. }) = slot.as_ref() {
                cancel.store(true, Ordering::Relaxed);
            }
            *slot = None;
            true
        } else {
            false
        }
    }

    pub fn close(&self) {
        let mut entries = self.entries.lock().unwrap();
        entries.live = false;
        for slot in &mut entries.slots {
            if let Some(Entry::Pending { cancel, .. }) = slot.as_ref() {
                cancel.store(true, Ordering::Relaxed);
            }
            *slot = None;
        }
    }

    pub fn charged(&self) -> u64 {
        self.charge.bytes()
            + self
                .entries
                .lock()
                .unwrap()
                .slots
                .iter()
                .map(|entry| match entry {
                    Some(Entry::Ready { image, .. }) => image.charged(),
                    _ => 0,
                })
                .sum::<u64>()
    }
}

/// A queued/running prepare occupies a slot. Every non-publication path removes it automatically.
pub struct Pending {
    // Declared before Raw in the NAPI task, so state contents release while Raw's metadata still lives.
    state: Arc<Resources>,
    id: u64,
    published: bool,
}

impl Pending {
    pub fn publish(&mut self, image: CanonicalImage) -> Result<Metadata, DocError> {
        let mut entries = self.state.entries.lock().unwrap();
        if !entries.live {
            return Err(DocError::Cancelled);
        }
        let slot = entries
            .slots
            .iter_mut()
            .find(|entry| entry.as_ref().is_some_and(|entry| entry.id() == self.id))
            .ok_or(DocError::Cancelled)?;
        match slot {
            Some(Entry::Pending { cancel, .. }) => cancelled(cancel)?,
            _ => return Err(DocError::Cancelled),
        }
        let metadata = Metadata {
            id: self.id,
            width: image.width,
            height: image.height,
            encoded_bytes: image.bytes().len() as u32,
            pixel_bytes: image.width * image.height * 4,
        };
        *slot = Some(Entry::Ready { id: self.id, image });
        self.published = true;
        Ok(metadata)
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.published {
            self.state.release(self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0f, 0x49, 0x44, 0x41, 0x54, 0x78, 1, 1, 4, 0, 0xfb, 0xff, 0,
        0x11, 0x1d, 0x2b, 0, 0x9c, 0, 0x5a, 0xa2, 0, 0x3a, 0x7e, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
        0x82,
    ];
    fn flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }
    fn image() -> CanonicalImage {
        images::decode(PNG, &AtomicBool::new(false)).unwrap()
    }

    #[test]
    fn pending_and_ready_both_count_against_the_two_slots() {
        let state = Resources::new(1).unwrap();
        let mut first = state.reserve(flag()).unwrap();
        let second = state.reserve(flag()).unwrap();
        assert!(matches!(state.reserve(flag()), Err(DocError::Refused(_))));
        let metadata = first.publish(image()).unwrap();
        assert!(matches!(state.reserve(flag()), Err(DocError::Refused(_))));
        drop(second);
        assert!(state.reserve(flag()).is_ok());
        assert!(state.release(metadata.id));
        assert!(!state.release(metadata.id));
    }

    #[test]
    fn close_cancels_pending_and_forbids_late_publication() {
        let state = Resources::new(7).unwrap();
        let cancel = flag();
        let mut pending = state.reserve(Arc::clone(&cancel)).unwrap();
        state.close();
        assert!(cancel.load(Ordering::Relaxed));
        assert!(matches!(pending.publish(image()), Err(DocError::Cancelled)));
        assert!(matches!(state.reserve(flag()), Err(DocError::Cancelled)));
        assert!(!state.contains(pending.id));
    }

    #[test]
    fn chunks_are_binary_bounded_aligned_and_released_idempotently() {
        let state = Resources::new(1).unwrap();
        let mut pending = state.reserve(flag()).unwrap();
        let metadata = pending.publish(image()).unwrap();
        let _work = Reservation::new(CHUNK as u64).unwrap();
        let bytes = state.chunk(metadata.id, 0).unwrap();
        assert_eq!(bytes.len(), metadata.encoded_bytes as usize);
        assert!(bytes.len() <= CHUNK && bytes.starts_with(b"\x89PNG"));
        assert!(matches!(state.chunk(metadata.id, 1), Err(DocError::Invalid(_))));
        assert!(matches!(state.chunk(metadata.id, CHUNK), Err(DocError::Invalid(_))));
        assert!(state.release(metadata.id));
        assert!(!state.release(metadata.id));
        assert!(matches!(state.chunk(metadata.id, 0), Err(DocError::Refused(_))));
    }

    #[test]
    fn resource_ids_use_max_safe_u64_without_truncation_or_wrap() {
        let state = Resources::new(1).unwrap();
        state.entries.lock().unwrap().next = MAX_SAFE;
        let last = state.reserve(flag()).unwrap();
        assert_eq!(last.id, MAX_SAFE);
        drop(last);
        assert!(matches!(state.reserve(flag()), Err(DocError::Refused(_))));
    }

    #[cfg(windows)]
    #[test]
    fn snapshot_cannot_verify_a_prefix_against_a_later_larger_file_identity() {
        use crate::store::testutil::temp_file;
        use std::io::Write;

        let source_path = temp_file("image-size-source.md", b"# image\n");
        let target_path = temp_file("image-size-target.png", PNG);
        let source = Document::open(&source_path).unwrap();
        let target = target_path.file_name().unwrap().to_str().unwrap();
        let cancel = AtomicBool::new(false);
        let mut snapshot = Snapshot::read(&source, 1, target, &cancel).unwrap();
        std::fs::OpenOptions::new().append(true).open(&target_path).unwrap().write_all(b"trailing").unwrap();
        // Reproduce the old metadata interleaving: bytes sized by the earlier observation, identity taken later.
        snapshot.id = FileId::of_file(&snapshot.file).unwrap();
        assert!(matches!(snapshot.verify(&source, 1, &cancel), Err(DocError::Refused(_))));
        drop(snapshot);

        std::fs::OpenOptions::new().write(true).open(&target_path).unwrap().set_len(MAX_SOURCE as u64 + 1).unwrap();
        assert!(matches!(Snapshot::read(&source, 1, target, &cancel), Err(DocError::Refused(_))));
    }
}
