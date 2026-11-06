//! Charged, generation-bound image resources, from a local file or from the document's own bytes (an embedded image).
//! Only canonical PNG bytes leave this module.
use std::borrow::Cow;
use std::fs::File;
use std::io::Read;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};

use crate::budget::Reservation;
use crate::doc::{DocError, Document, FileId, MAX_SAFE, local_error};
use crate::images::{self, CanonicalImage, ImageError, MAX_SOURCE};
use crate::local::LocalRoute;
use crate::store::StoreError;

pub const CHUNK: usize = 256 << 10;
/// The most source bytes an embedded image's span may cover: `MAX_SOURCE` as padded base64, plus 64 bytes for a
/// `data:` header and a JSON string's quotes.
pub const MAX_EMBEDDED: u64 = (MAX_SOURCE as u64).div_ceil(3) * 4 + 64;
const TOO_BIG: &str = "Embedded image exceeds 8 MiB";
const NOT_BASE64: &str = "Embedded image is not strict base64";
const STATE_BYTES: u64 = 4096; // fixed two-slot state, Mutex, Arc and allocator overhead
static CODEC_BUSY: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
thread_local! {
    /// Embedded-image input reservations made on this thread.
    static EMBEDDED_CHARGES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
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

fn refused(why: &str) -> DocError {
    DocError::Refused(why.into())
}

/// The base64 of a `data:image/(png|jpeg|gif|webp);base64,` URL (any case), or `text` itself as a bare payload. Any
/// other declared type is refused, SVG with its own reason. The codec, never this header, identifies the format.
fn base64_payload(text: &[u8]) -> Result<&[u8], DocError> {
    if !text.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case(b"data:")) {
        return Ok(text);
    }
    let comma = memchr::memchr(b',', &text[..text.len().min(64)]).ok_or_else(|| refused("Malformed data: URL"))?;
    let header = &text[5..comma];
    let base64 = header.len().checked_sub(7).filter(|&at| header[at..].eq_ignore_ascii_case(b";base64"));
    let Some(mime) = base64.map(|at| header[..at].to_ascii_lowercase()) else {
        return Err(refused("A data: image must be base64"));
    };
    match mime.as_slice() {
        b"image/png" | b"image/jpeg" | b"image/gif" | b"image/webp" => Ok(&text[comma + 1..]),
        b"image/svg+xml" => Err(refused("SVG images are not supported")),
        other if !other.is_empty() && other.iter().all(u8::is_ascii_graphic) => {
            Err(DocError::Refused(format!("Unsupported image type {}", String::from_utf8_lossy(other))))
        }
        _ => Err(refused("Unsupported data: image type")),
    }
}

/// RFC 4648 base64, strictly: only its alphabet, `=` padding to a multiple of 4, and zero padding bits. The output is
/// at most `MAX_SOURCE`, checked before it's allocated.
fn strict_base64(text: &[u8], cancel: &AtomicBool) -> Result<Vec<u8>, DocError> {
    let pad = text.iter().rev().take_while(|&&b| b == b'=').count();
    if text.is_empty() || !text.len().is_multiple_of(4) || pad > 2 {
        return Err(refused(NOT_BASE64));
    }
    let len = text.len() / 4 * 3 - pad;
    if len > MAX_SOURCE {
        return Err(refused(TOO_BIG));
    }
    let mut out = Vec::new();
    out.try_reserve_exact(len).map_err(|_| refused("image input allocation failed"))?;
    for (i, group) in text[..text.len() - pad].chunks(4).enumerate() {
        if i.is_multiple_of(CHUNK / 4) {
            cancelled(cancel)?;
        }
        let mut v = 0u32;
        for &c in group {
            let sextet = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return Err(refused(NOT_BASE64)),
            };
            v = v << 6 | u32::from(sextet);
        }
        match group.len() {
            4 => out.extend_from_slice(&[(v >> 16) as u8, (v >> 8) as u8, v as u8]),
            3 if v & 0b11 == 0 => out.extend_from_slice(&[(v >> 10) as u8, (v >> 2) as u8]),
            2 if v & 0b1111 == 0 => out.push((v >> 4) as u8),
            _ => return Err(refused(NOT_BASE64)),
        }
    }
    Ok(out)
}

/// An embedded image's decoded payload and its charge, `Snapshot`'s counterpart. Read once, through the document's
/// verified store.
struct Embedded {
    bytes: Vec<u8>,
    // Last: the payload drops before its memory charge.
    _charge: Reservation,
}

impl Embedded {
    /// The span's bytes in `encoding`, in one of three forms: a `data:` URL or a bare payload (`base64_payload`), or a
    /// JSON string token holding either, unescaped by `json::unescape` (never longer than its token).
    fn read(
        source: &Document,
        encoding: &'static Encoding,
        generation: u32,
        span: Range<u64>,
        cancel: &AtomicBool,
    ) -> Result<Self, DocError> {
        cancelled(cancel)?;
        let len = (span.end - span.start) as usize;
        let text_len = if encoding == UTF_8 {
            len
        } else {
            let decoder = encoding.new_decoder_without_bom_handling();
            decoder.max_utf8_buffer_length_without_replacement(len).ok_or_else(|| refused(TOO_BIG))?
        };
        let decoded = if encoding == UTF_8 { 0 } else { text_len }; // UTF-8 is checked in place
        // The read and its temporaries, as Markdown's (`md::read_temp`: the decode, a chunk on its way into the cache,
        // the identity check's path copies), each chunk `store.read` returns, a JSON string's unescaped copy and the
        // payload.
        let temp = crate::md::read_temp(len as u64, Some(decoded));
        let mut charge = Reservation::new(temp + (CHUNK + text_len + MAX_SOURCE.min(text_len / 4 * 3)) as u64)
            .map_err(DocError::Memory)?;
        #[cfg(test)]
        EMBEDDED_CHARGES.set(EMBEDDED_CHARGES.get() + 1);
        let payload = {
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(len).map_err(|_| refused("image input allocation failed"))?;
            source.verified(generation, |store| {
                for at in (span.start..span.end).step_by(CHUNK) {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(StoreError::Cancelled);
                    }
                    bytes.extend_from_slice(&store.read(at, span.end.min(at + CHUNK as u64))?);
                }
                Ok(())
            })?;
            let text = if encoding == UTF_8 {
                std::str::from_utf8(&bytes).ok().map(Cow::Borrowed)
            } else {
                encoding.decode_without_bom_handling_and_without_replacement(&bytes)
            };
            let text = text.ok_or_else(|| refused("Embedded image is not text"))?;
            let unescaped;
            let text = match text.as_bytes() {
                [b'"', inner @ .., b'"'] if inner.iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 0 => {
                    unescaped = crate::json::unescape(text.as_bytes());
                    &unescaped[..]
                }
                [b'"', ..] => return Err(refused("Embedded image is not a JSON string")),
                text => text,
            };
            strict_base64(base64_payload(text)?, cancel)?
        };
        // The read, its decode and copies are gone: keep the payload's charge, and the path copies' for the check after
        // the decode.
        charge.shrink(charge.bytes().saturating_sub(crate::md::read_temp(payload.capacity() as u64, Some(0))));
        Ok(Self { bytes: payload, _charge: charge })
    }
}

/// The image a document carries in its own bytes `span` of generation `generation`, read in `encoding`: a `data:`
/// image URL, a bare base64 payload, or a JSON string holding either (`Embedded::read`). The span is bounded
/// (`MAX_EMBEDDED`) and checked against the generation and the document before anything is reserved or read; then,
/// as `prepare`, it decodes under the codec permit and the source is checked again. Nothing from the caller is
/// trusted: a span that isn't one of the forms is refused.
pub fn prepare_embedded(
    source: &Document,
    encoding: &'static Encoding,
    generation: u32,
    span: Range<u64>,
    cancel: &AtomicBool,
) -> Result<CanonicalImage, DocError> {
    if span.start >= span.end {
        return Err(DocError::Invalid("Image span must be non-empty".into()));
    }
    if span.end - span.start > MAX_EMBEDDED {
        return Err(refused(TOO_BIG));
    }
    if generation != source.generation() {
        return Err(DocError::Stale { current: source.generation(), asked: generation });
    }
    if span.end > source.len() {
        return Err(DocError::Invalid("Image span is outside the document".into()));
    }
    let permit = CodecPermit::take(cancel)?;
    let payload = Embedded::read(source, encoding, generation, span, cancel)?;
    let image = images::decode(&payload.bytes, cancel).map_err(image_error)?;
    cancelled(cancel)?;
    source.verified(generation, |_| Ok(()))?; // the source is unchanged through the decode
    drop(payload);
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

    // ---- Embedded images (Z43) ----

    fn b64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in bytes.chunks(3) {
            let v = c.iter().fold(0u32, |v, &b| v << 8 | u32::from(b)) << (8 * (3 - c.len()));
            for i in 0..4 {
                out.push(if i <= c.len() { ALPHABET[(v >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        out
    }

    fn open(name: &str, bytes: &[u8]) -> (crate::store::testutil::Temp, Document) {
        let path = crate::store::testutil::temp_file(name, bytes);
        let doc = Document::open(&path).unwrap();
        (path, doc)
    }

    fn embedded(doc: &Document, span: Range<u64>) -> Result<CanonicalImage, DocError> {
        prepare_embedded(doc, UTF_8, 1, span, &AtomicBool::new(false))
    }

    fn refusal(result: Result<CanonicalImage, DocError>) -> String {
        match result {
            Err(DocError::Refused(why)) => why,
            other => panic!("not a refusal: {other:?}"),
        }
    }

    #[test]
    fn base64_is_strict_about_alphabet_padding_and_whitespace() {
        let no = AtomicBool::new(false);
        assert_eq!(strict_base64(b"TWFu", &no).unwrap(), b"Man");
        assert_eq!(strict_base64(b"TWE=", &no).unwrap(), b"Ma");
        assert_eq!(strict_base64(b"TQ==", &no).unwrap(), b"M");
        assert_eq!(strict_base64(b"+/+/", &no).unwrap(), [0xfb, 0xff, 0xbf]);
        for bad in [
            &b""[..],
            b"TWF",
            b"TWFu ",
            b" TWFu",
            b"TW\nFu",
            b"TW\tF",
            b"TW-u",
            b"TW_u",
            b"TWFu%3D",
            b"TQ=",
            b"T===",
            b"====",
            b"TQ=A",
            b"TWE=TWFu",
            b"TR==",
            b"TWF=",
        ] {
            assert!(
                matches!(strict_base64(bad, &no), Err(DocError::Refused(why)) if why == NOT_BASE64),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn each_declared_image_type_in_any_case_yields_its_payload() {
        for header in [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/gif;base64,",
            "data:image/webp;base64,",
            "DATA:IMAGE/PNG;BASE64,",
            "data:Image/Jpeg;Base64,",
        ] {
            assert_eq!(base64_payload(format!("{header}TWFu").as_bytes()).unwrap(), b"TWFu", "{header}");
        }
        assert_eq!(base64_payload(b"TWFu").unwrap(), b"TWFu"); // a bare payload is itself
    }

    #[test]
    fn svg_other_types_and_other_headers_are_refused_with_their_reason() {
        for (text, why) in [
            ("data:image/svg+xml;base64,PHN2Zy8+", "SVG images are not supported"),
            ("data:IMAGE/SVG+XML;base64,PHN2Zy8+", "SVG images are not supported"),
            ("data:text/html;base64,PGI+", "Unsupported image type text/html"),
            ("data:image/bmp;base64,Qk0=", "Unsupported image type image/bmp"),
            ("data:;base64,TWFu", "Unsupported data: image type"),
            ("data:image/png,TWFu", "A data: image must be base64"),
            ("data:image/png;base64TWFu", "Malformed data: URL"),
        ] {
            assert!(matches!(base64_payload(text.as_bytes()), Err(DocError::Refused(got)) if got == why), "{text}");
        }
    }

    #[test]
    fn a_data_url_a_bare_payload_and_a_json_string_of_either_decode() {
        let png = b64(PNG);
        assert!(png.starts_with('i'));
        let escaped = format!("\\u0069{}", png[1..].replace('/', "\\/")); // JSON's \u and \/ escapes
        for (name, text) in [
            ("embedded-url.txt", format!("data:image/png;base64,{png}")),
            ("embedded-case.txt", format!("DATA:Image/PNG;Base64,{png}")),
            ("embedded-declared.txt", format!("data:image/gif;base64,{png}")), // the codec, not the header, decides
            ("embedded-bare.txt", png.clone()),
            ("embedded-json-url.txt", format!("\"data:image/png;base64,{escaped}\"")),
            ("embedded-json-bare.txt", format!("\"{escaped}\"")),
        ] {
            let (_path, doc) = open(name, format!("[{text}]").as_bytes()); // the span sits inside other bytes
            let image = embedded(&doc, 1..1 + text.len() as u64).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.width, image.height), (1, 1), "{name}");
        }
    }

    #[test]
    fn a_span_that_is_not_one_image_form_is_refused_with_its_reason() {
        let png = b64(PNG);
        for (name, text, why) in [
            (
                "embedded-svg.txt",
                format!("data:image/svg+xml;base64,{}", b64(b"<svg/>")),
                "SVG images are not supported",
            ),
            ("embedded-html.txt", format!("data:text/html;base64,{png}"), "Unsupported image type text/html"),
            ("embedded-space.txt", format!("{png} "), NOT_BASE64),
            ("embedded-line.txt", format!("{}\r\n{}", &png[..8], &png[8..]), NOT_BASE64),
            ("embedded-open.txt", format!("\"{png}"), "Embedded image is not a JSON string"),
            ("embedded-escaped.txt", format!("\"{png}\\\""), "Embedded image is not a JSON string"),
            ("embedded-nested.txt", format!("\"\\\"{png}\\\"\""), NOT_BASE64),
            ("embedded-text.txt", format!("data:image/png;base64,{}", b64(b"hello")), "unsupported image format"),
            (
                "embedded-webp.txt",
                format!("data:image/webp;base64,{}", b64(b"RIFF\0\0\0\0WEBPVP8 ")),
                "WebP images are not supported yet",
            ),
        ] {
            let (_path, doc) = open(name, text.as_bytes());
            assert_eq!(refusal(embedded(&doc, 0..text.len() as u64)), why, "{name}");
        }
        let (_path, doc) = open("embedded-latin.txt", b"\xff\xfe");
        assert_eq!(refusal(embedded(&doc, 0..2)), "Embedded image is not text");
    }

    #[test]
    fn an_over_bound_span_is_refused_before_anything_is_reserved_or_read() {
        let (_path, doc) = open("embedded-bound.txt", b"data:image/png;base64,TWFu");
        let flag = AtomicBool::new(false);
        let (charges, checks) = (EMBEDDED_CHARGES.get(), crate::doc::CHECKS.get());
        for generation in [1, 9] {
            let got = prepare_embedded(&doc, UTF_8, generation, 0..MAX_EMBEDDED + 1, &flag);
            assert_eq!(refusal(got), TOO_BIG); // before the generation, the document's length or a reservation
        }
        assert_eq!((EMBEDDED_CHARGES.get(), crate::doc::CHECKS.get()), (charges, checks));
        assert!(matches!(embedded(&doc, 0..MAX_EMBEDDED), Err(DocError::Invalid(_)))); // at the bound: then its place
        assert!(matches!(embedded(&doc, 3..3), Err(DocError::Invalid(_))));
        assert!(matches!(embedded(&doc, Range { start: 4, end: 3 }), Err(DocError::Invalid(_))));
        assert!(matches!(embedded(&doc, 0..27), Err(DocError::Invalid(_)))); // one past the end
        let stale = prepare_embedded(&doc, UTF_8, 2, 0..26, &flag);
        assert!(matches!(stale, Err(DocError::Stale { current: 1, asked: 2 })), "{stale:?}");
        flag.store(true, Ordering::Relaxed);
        assert!(matches!(prepare_embedded(&doc, UTF_8, 1, 0..26, &flag), Err(DocError::Cancelled)));
        assert_eq!((EMBEDDED_CHARGES.get(), crate::doc::CHECKS.get()), (charges, checks));
        assert_eq!(refusal(embedded(&doc, 0..26)), "unsupported image format"); // read, once in range
        assert_eq!((EMBEDDED_CHARGES.get(), crate::doc::CHECKS.get()), (charges + 1, checks + 1));
    }

    #[test]
    fn a_payload_decoding_past_8_mib_is_refused_and_exactly_8_mib_reaches_the_codec() {
        let mut text = vec![b'A'; (MAX_SOURCE + 1).div_ceil(3) * 4]; // MAX_SOURCE + 1 bytes, within the span bound
        assert!(text.len() as u64 <= MAX_EMBEDDED);
        let (_path, doc) = open("embedded-over.txt", &text);
        assert_eq!(refusal(embedded(&doc, 0..text.len() as u64)), TOO_BIG);
        *text.last_mut().unwrap() = b'=';
        let (_path, doc) = open("embedded-at.txt", &text);
        assert_eq!(refusal(embedded(&doc, 0..text.len() as u64)), "unsupported image format");
    }

    #[test]
    fn a_rendered_span_is_its_urls_bytes_in_utf8_a_bom_and_utf16() {
        let url = format!("data:image/png;base64,{}", b64(PNG));
        let md = format!("# Embedded\r\n\r\nAn ![é 画像]({url}) here\r\n");
        let utf16 = |bom: [u8; 2], unit: fn(u16) -> [u8; 2]| -> Vec<u8> {
            bom.into_iter().chain(md.encode_utf16().flat_map(unit)).collect()
        };
        for (name, bytes, encoded) in [
            ("embedded-utf8.md", md.clone().into_bytes(), url.clone().into_bytes()),
            ("embedded-bom.md", [b"\xef\xbb\xbf", md.as_bytes()].concat(), url.clone().into_bytes()),
            (
                "embedded-le.md",
                utf16([0xff, 0xfe], u16::to_le_bytes),
                url.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            ),
            (
                "embedded-be.md",
                utf16([0xfe, 0xff], u16::to_be_bytes),
                url.encode_utf16().flat_map(u16::to_be_bytes).collect(),
            ),
        ] {
            let path = crate::store::testutil::temp_file(name, &bytes);
            let raw = crate::raw::Raw::open(&path).unwrap();
            let html: String = raw.render(1).unwrap().items().iter().map(|i| i.html.to_string()).collect();
            assert!(!html.contains("base64"), "{name}: {html}");
            let (start, end) =
                html.split_once("data-embedded=\"").unwrap().1.split_once('"').unwrap().0.split_once(',').unwrap();
            let span: Range<u64> = start.parse().unwrap()..end.parse().unwrap();
            assert_eq!(&bytes[span.start as usize..span.end as usize], encoded, "{name}");
            let image = raw.embedded_image(1, span, &AtomicBool::new(false)).unwrap();
            assert_eq!((image.width, image.height), (1, 1), "{name}");
        }
    }

    /// Z43, D17: a screenshot-sized image (real ones reach 512 KB decoded) renders from a paragraph, its URL left out
    /// of the block's 64 KiB, inline and by reference, the definition at the top level or inside the block. Each form
    /// that doesn't is listed.
    #[test]
    fn a_300_kb_image_renders_inline_and_by_reference() {
        let mut state = 0x9e37_79b9_u32;
        let mut noise = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        };
        let pixels: Vec<u8> = (0..320 * 320 * 3).map(|_| noise()).collect();
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, 320, 320);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_deflate_compression(png::DeflateCompression::NoCompression);
        encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
        assert!((300_000..320_000).contains(&png.len()), "{}", png.len());
        let url = format!("data:image/png;base64,{}", b64(&png));
        let mut failed = Vec::new();
        for (i, (form, md)) in [
            ("inline", format!("# Shot\n\nA screenshot: ![shot]({url})\n")),
            ("reference", format!("# Shot\n\nA screenshot: ![shot][s]\n\n[s]: {url}\n")),
            ("reference in its block", format!("# Shot\n\n- A screenshot: ![shot][s]\n\n  [s]: {url}\n")),
        ]
        .into_iter()
        .enumerate()
        {
            let path = crate::store::testutil::temp_file(&format!("embedded-300k-{i}.md"), md.as_bytes());
            let raw = crate::raw::Raw::open(&path).unwrap();
            let rendered = raw.render(1).unwrap();
            let item = &rendered.items()[1];
            let span = item.html.split_once("data-embedded=\"").and_then(|(_, rest)| rest.split_once('"'));
            let span = span
                .and_then(|(span, _)| span.split_once(','))
                .map(|(start, end)| start.parse::<u64>().unwrap()..end.parse::<u64>().unwrap());
            let shown = item.note.is_none() && !item.html.contains(&url[22..64]);
            match span.filter(|_| shown) {
                Some(span) => {
                    let image = raw.embedded_image(1, span, &AtomicBool::new(false)).unwrap();
                    assert_eq!((image.width, image.height), (320, 320), "{form}");
                }
                None => failed.push((form, item.note)),
            }
        }
        assert_eq!(failed, [], "not shown");
    }
}
