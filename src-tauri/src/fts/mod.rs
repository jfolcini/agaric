//! FTS5 full-text search backend.
//!
//! Provides strip/index/search functions for the `fts_blocks` virtual table.
//! The strip pass converts raw block content to plain text for FTS indexing
//! by removing markdown formatting and resolving tag/page references.
//!
//! ## Design
//!
//! - `strip_for_fts` — async, resolves `#[ULID]` and `[[ULID]]` via DB lookups
//! - `strip_for_fts_with_maps` — sync, uses pre-loaded HashMaps (batch rebuild)
//! - `update_fts_for_block` — index one block
//! - `remove_fts_for_block` — remove one block from index
//! - `rebuild_fts_index` — full reindex of all active blocks
//! - `fts_optimize` — run FTS5 segment merge
//! - `search_fts` — FTS5 MATCH query with cursor-based pagination

mod index;
mod search;
pub(crate) mod strip;

#[cfg(test)]
mod tests;

// Re-export public API
pub use index::{
    fts_optimize, rebuild_fts_index, rebuild_fts_index_split, reindex_fts_references,
    remove_fts_for_block, update_fts_for_block,
};
pub use search::search_fts;
pub use strip::strip_for_fts;

// Re-export crate-internal API
pub(crate) use search::sanitize_fts_query;
pub(crate) use strip::{PAGE_LINK_RE, TAG_REF_RE};
