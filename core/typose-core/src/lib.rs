//! Typose's core: the byte store, documents, decoding, the line index and Raw pages.
//! See docs/superpowers/specs/2026-10-20-typose-tech-design.md §3.

// `len` here is a file or table size; nothing is a container that could be empty-checked.
#![allow(clippy::len_without_is_empty)]

pub mod bytemap;
pub mod doc;
pub mod encoding;
pub mod index;
pub mod limits;
pub mod pages;
pub mod raw;
pub mod store;

#[cfg(test)]
mod big_offsets;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// PLANT (plan PR 2 acceptance; reverted): a formatting error, which `cargo fmt --check` must fail on.
pub fn planted_fmt_error( ) -> u8 {1}

// PLANT (plan PR 2 acceptance; reverted): a clippy warning (ptr_arg), which clippy -D warnings must fail on.
pub fn planted_clippy_warning(v: &Vec<u8>) -> usize {
    v.len()
}
