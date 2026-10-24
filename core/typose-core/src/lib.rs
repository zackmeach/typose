//! Typose's core: the byte store, documents, decoding, the line index, Raw pages and Rendered Markdown.
//! See docs/superpowers/specs/2026-10-20-typose-tech-design.md §3.

// `len` here is a file or table size; nothing is a container that could be empty-checked.
#![allow(clippy::len_without_is_empty)]

pub mod budget;
pub mod bytemap;
pub mod doc;
pub mod encoding;
#[cfg(feature = "test-hooks")]
pub mod hooks;
pub mod index;
pub mod limits;
pub mod md;
pub mod pages;
pub mod raw;
pub mod sanitize;
pub mod store;

#[cfg(test)]
mod big_offsets;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
