//! Verified structured lenses over the span-only JSON scanner.
use crate::budget::Reservation;
use crate::doc::{DocError, Document};
use crate::json::{self, JsonIndex};
use crate::store::{StoreError, cancelled};

pub const TEMP_BYTES: u64 = 16 << 20;
pub struct JsonTree {
    pub index: JsonIndex,
    pub duplicates: Vec<(u32, u64)>,
    duplicate_charge: Reservation,
    /// A record-scoped tree finds an object's duplicate keys when a page lists it, not at build.
    lazy_duplicates: bool,
}
/// The pre-sized key-hash set `json::duplicate_keys` holds for an object of `members`.
fn key_workspace(members: u64) -> Result<Reservation, DocError> {
    let bytes =
        members.checked_mul(80).ok_or_else(|| DocError::Invalid("duplicate key workspace size overflow".into()))?;
    Reservation::new(TEMP_BYTES + bytes).map_err(DocError::Memory)
}
impl JsonTree {
    pub fn build(doc: &Document, generation: u32) -> Result<Self, DocError> {
        let mut tree = Self::build_range(doc, generation, 0..doc.len(), true)?;
        tree.lazy_duplicates = false;
        let (index, duplicates, charge) = (&tree.index, &mut tree.duplicates, &mut tree.duplicate_charge);
        // One verified pass for every object: the identity check opens the file, so never once per object.
        doc.verified(generation, |store| {
            for (id, container) in index.containers.iter().enumerate() {
                if cancelled() {
                    return Err(StoreError::Cancelled);
                }
                if container.kind != json::Kind::Object || container.children < 2 {
                    continue; // only an object of two members or more can repeat a key
                }
                let _keys = match key_workspace(container.children) {
                    Ok(keys) => keys,
                    Err(e) => return Ok(Err(e)),
                };
                let found = json::duplicate_keys(store, index, id as u32)?.ok_or(StoreError::Cancelled)?;
                for ordinal in found {
                    if duplicates.len() == duplicates.capacity() {
                        let old = duplicates.capacity();
                        let next = old.max(32) * 2;
                        if let Err(e) = charge.grow((next * size_of::<(u32, u64)>()) as u64) {
                            return Ok(Err(DocError::Memory(e)));
                        }
                        duplicates.reserve_exact(next - duplicates.len());
                        charge.shrink((old * size_of::<(u32, u64)>()) as u64);
                    }
                    duplicates.push((id as u32, ordinal));
                }
            }
            Ok(Ok(()))
        })??;
        Ok(tree)
    }
    pub fn build_range(
        doc: &Document,
        generation: u32,
        range: std::ops::Range<u64>,
        jsonc: bool,
    ) -> Result<Self, DocError> {
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let index = doc.verified(generation, |store| json::scan(store, range, jsonc))?;
        if let Some(error) = index.error {
            match error.kind {
                json::ErrorKind::Memory(e) => return Err(DocError::Memory(e)),
                json::ErrorKind::Cancelled => return Err(DocError::Cancelled),
                _ => {}
            }
        }
        Ok(Self { index, duplicates: Vec::new(), duplicate_charge: Reservation::none(), lazy_duplicates: true })
    }
    pub fn children(
        &self,
        doc: &Document,
        generation: u32,
        container: u32,
        start: u64,
        count: usize,
    ) -> Result<Vec<(u64, json::Child, bool)>, DocError> {
        if count == 0 || count > 128 {
            return Err(DocError::Invalid("Tree child count must be 1–128".into()));
        }
        let _temp = Reservation::new(TEMP_BYTES).map_err(DocError::Memory)?;
        let lazy = self
            .index
            .containers
            .get(container as usize)
            .filter(|c| self.lazy_duplicates && c.kind == json::Kind::Object && c.children >= 2);
        let _keys = lazy.map(|c| key_workspace(c.children)).transpose()?;
        doc.verified(generation, |store| {
            if cancelled() {
                return Err(StoreError::Cancelled);
            }
            let children = json::children(store, &self.index, container, start, count)?;
            let found = match lazy {
                Some(_) => json::duplicate_keys(store, &self.index, container)?.ok_or(StoreError::Cancelled)?,
                None => Vec::new(),
            };
            Ok(children
                .into_iter()
                .enumerate()
                .map(|(i, node)| {
                    let ordinal = start + i as u64;
                    let duplicate = if self.lazy_duplicates {
                        found.binary_search(&ordinal).is_ok()
                    } else {
                        self.duplicates.binary_search(&(container, ordinal)).is_ok()
                    };
                    (ordinal, node, duplicate)
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
        let tree = JsonTree::build(&doc, 1).unwrap();
        assert!(tree.index.error.is_none());
        assert_eq!(tree.index.trivia.comments, 1);
        assert_eq!(tree.index.trivia.trailing_commas, 1);
        let nodes = tree.children(&doc, 1, 0, 0, 128).unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(nodes[1].2);
        assert!(!nodes[0].2);
        assert_eq!(doc.read(1, nodes[0].1.value.start, nodes[0].1.value.end).unwrap(), b"12345678901234567890");
        assert_eq!(nodes[1].1.text, b"3.10");
        assert_eq!(nodes[2].1.text, b"1e400");
        assert!(tree.charged() > 0);
    }
    #[test]
    fn a_tree_build_checks_the_file_once_per_pass_not_once_per_object() {
        let mut bytes = b"[".to_vec();
        for i in 0..2000 {
            bytes.extend_from_slice(if i == 0 { b"" } else { b"," });
            bytes.extend_from_slice(br#"{"a":1,"b":{"c":2,"c":3},"e":{},"f":[]}"#);
        }
        bytes.push(b']');
        let file = temp_file("structured-check-count", &bytes);
        let doc = Document::open(&file).unwrap();
        let before = crate::doc::CHECKS.get();
        let tree = JsonTree::build(&doc, 1).unwrap();
        assert_eq!(crate::doc::CHECKS.get() - before, 2); // the scan and the duplicate pass
        assert_eq!(tree.duplicates.len(), 2000);
        // A record-scoped tree finds duplicates only for the object a page lists.
        let before = crate::doc::CHECKS.get();
        let record = JsonTree::build_range(&doc, 1, 1..40, false).unwrap();
        assert_eq!(crate::doc::CHECKS.get() - before, 1);
        assert!(record.duplicates.is_empty());
        let marks: Vec<bool> = record.children(&doc, 1, 1, 0, 128).unwrap().into_iter().map(|c| c.2).collect();
        assert_eq!(marks, [false, true]);
    }
    #[test]
    fn partial_json_retains_prior_children_and_rejects_controls() {
        let file = temp_file("structured-json-partial", b"{\"a\":1,\"bad\":\"hello\nworld\"}");
        let doc = Document::open(&file).unwrap();
        let tree = JsonTree::build(&doc, 1).unwrap();
        assert!(tree.index.error.is_some());
        assert_eq!(tree.children(&doc, 1, 0, 0, 128).unwrap().len(), 1);
    }
}
