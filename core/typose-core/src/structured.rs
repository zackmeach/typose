//! Verified structured lenses over the span-only JSON scanner.
use crate::budget::Reservation;
use crate::doc::{DocError, Document};
use crate::json::{self, JsonIndex, ScanOptions};
use std::sync::atomic::AtomicBool;

pub const TEMP_BYTES: u64 = 16 << 20;
pub struct JsonTree {
    pub index: JsonIndex,
    pub duplicates: Vec<(u32, u64)>,
    duplicate_charge: Reservation,
}
impl JsonTree {
    pub fn build(doc: &Document, generation: u32, cancel: &AtomicBool) -> Result<Self, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let index =
            doc.verified(generation, |store| json::scan(store, 0..doc.len(), &ScanOptions::default(), cancel))?;
        if let Some(error) = index.error {
            match error.kind {
                json::ErrorKind::Memory(e) => return Err(DocError::Memory(e)),
                json::ErrorKind::Cancelled => return Err(DocError::Cancelled),
                _ => {}
            }
        }
        let mut duplicates = Vec::new();
        let mut duplicate_charge = Reservation::none();
        for (id, container) in index.containers.iter().enumerate() {
            if container.kind != json::Kind::Object {
                continue;
            }
            let _keys = Reservation::new(
                TEMP_BYTES
                    + container
                        .children
                        .checked_mul(80)
                        .ok_or_else(|| DocError::Invalid("duplicate key workspace size overflow".into()))?,
            )
            .map_err(DocError::Memory)?;
            let found = doc
                .verified(generation, |store| json::duplicate_keys(store, &index, id as u32, cancel))?
                .ok_or(DocError::Cancelled)?;
            for ordinal in found {
                if duplicates.len() == duplicates.capacity() {
                    let old = duplicates.capacity();
                    let next = old.max(32) * 2;
                    duplicate_charge.grow((next * size_of::<(u32, u64)>()) as u64).map_err(DocError::Memory)?;
                    duplicates.reserve_exact(next - duplicates.len());
                    duplicate_charge.shrink((old * size_of::<(u32, u64)>()) as u64);
                }
                duplicates.push((id as u32, ordinal));
            }
        }
        Ok(Self { index, duplicates, duplicate_charge })
    }
    pub fn children(
        &self,
        doc: &Document,
        generation: u32,
        container: u32,
        start: u64,
        count: usize,
        cancel: &AtomicBool,
    ) -> Result<Vec<(u64, json::Child, bool)>, DocError> {
        if count == 0 || count > 128 {
            return Err(DocError::Invalid("Tree child count must be 1–128".into()));
        }
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        doc.verified(generation, |store| {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(crate::store::StoreError::Cancelled);
            }
            let children = json::children(store, &self.index, container, start, count)?;
            Ok(children
                .into_iter()
                .enumerate()
                .map(|(i, node)| {
                    let ordinal = start + i as u64;
                    (ordinal, node, self.duplicates.binary_search(&(container, ordinal)).is_ok())
                })
                .collect())
        })
    }
    pub fn charged(&self) -> u64 {
        self.index.charged() + self.duplicate_charge.bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    #[test]
    fn jsonc_duplicate_keys_and_number_lexemes_keep_source_spans() {
        let bytes = b"{/* note */\"n\":12345678901234567890,\"n\":3.10,\"x\":1e400,}";
        let file = temp_file("structured-jsonc-spans", bytes);
        let doc = Document::open(&file).unwrap();
        let cancel = AtomicBool::new(false);
        let tree = JsonTree::build(&doc, 1, &cancel).unwrap();
        assert!(tree.index.error.is_none());
        assert_eq!(tree.index.trivia.comments, 1);
        assert_eq!(tree.index.trivia.trailing_commas, 1);
        let nodes = tree.children(&doc, 1, 0, 0, 128, &cancel).unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(nodes[1].2);
        assert!(!nodes[0].2);
        assert_eq!(doc.read(1, nodes[0].1.value.start, nodes[0].1.value.end).unwrap(), b"12345678901234567890");
        assert_eq!(nodes[1].1.text, b"3.10");
        assert_eq!(nodes[2].1.text, b"1e400");
        assert!(tree.charged() > 0);
    }
    #[test]
    fn partial_json_retains_prior_children_and_rejects_controls() {
        let file = temp_file("structured-json-partial", b"{\"a\":1,\"bad\":\"hello\nworld\"}");
        let doc = Document::open(&file).unwrap();
        let cancel = AtomicBool::new(false);
        let tree = JsonTree::build(&doc, 1, &cancel).unwrap();
        assert!(tree.index.error.is_some());
        assert_eq!(tree.children(&doc, 1, 0, 0, 128, &cancel).unwrap().len(), 1);
    }
}
