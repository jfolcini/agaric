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

pub(crate) mod glob_filter;
mod index;
pub mod metadata_filter;
mod search;
pub(crate) mod strip;
mod toggle_filter;

#[cfg(test)]
mod tests;

// Re-export public API
pub use index::{
    fts_optimize, rebuild_fts_index, rebuild_fts_index_split, reindex_fts_references,
    remove_fts_for_block, update_fts_for_block, update_fts_for_block_split,
    update_fts_for_block_split_with_maps, update_fts_for_block_with_maps,
};
pub use search::search_fts;
pub use strip::strip_for_fts;
pub use toggle_filter::{search_with_toggles, SearchToggles};

// PEND-61 Phase 1 — partitioned FTS scan for the multi-mode palette.
// `search_with_toggles_partitioned` is the single entry-point; it
// dispatches into `search_fts_partitioned` or `regex_mode_query` based
// on the toggle bundle. `pub(crate)` because the return type
// `FtsPartitionedScan` is also `pub(crate)` — the IPC wrapper unpacks
// it before returning to clients.
pub(crate) use toggle_filter::search_with_toggles_partitioned;

// Re-export crate-internal API
pub(crate) use search::sanitize_fts_query;
// PEND-58f BE-2 — the partitioned IPC command validates its
// `page_limit` / `block_limit` against this ceiling and rejects an
// over-limit request (the cursor path rejects via `PageRequest::new`).
pub(crate) use search::MAX_SEARCH_RESULTS;
pub(crate) use strip::{load_ref_maps, PAGE_LINK_RE, TAG_REF_RE};
