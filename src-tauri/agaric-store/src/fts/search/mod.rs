//! FTS5 search and query processing.
//!
//! This module is split into focused submodules; `mod.rs` is a thin
//! facade that wires them together and re-exports the public surface so
//! every existing `crate::fts::search::X` / `super::search::X` import
//! path keeps resolving unchanged:
//!
//! - [`tokenizer`] — splits a raw query into quoted phrases and words.
//! - [`sanitizer`] — turns the tokens into a safe FTS5 MATCH expression
//!   (the [`sanitize_fts_query`] helper).
//! - [`constants`] — highlight sentinels, snippet projection, timing
//!   thresholds, and the result / query-length ceilings.
//! - [`row`] — the raw DB row shape and its mapping to the IPC wire row.
//! - [`fetch`] — the shared dynamic-SQL builder + executor + FTS5
//!   error mapping.
//! - [`cursor`] — the cursor-paginated [`search_fts`] entry point.
//! - [`post_filter`] — filter-aware cursor pagination for the toggle path.
//! - [`partitioned`] — the two-partition palette scan.

mod constants;
mod cursor;
mod fetch;
mod partitioned;
mod post_filter;
mod row;
mod sanitizer;
mod tokenizer;

// ---------------------------------------------------------------------------
// Public re-exports — preserve the pre-split `fts::search::X` surface so
// callers (siblings under `fts`, plus the `fts` facade) compile unchanged.
// ---------------------------------------------------------------------------

// Cursor-paginated entry point (the `search_blocks` IPC command).
pub use cursor::search_fts;

// Query sanitiser (used by backlink / query-engine paths via `crate::fts`).
// #2945 — widened `pub(crate)` → `pub` so the libFuzzer `fts_strip` harness
// can reach `agaric_store::fts::sanitize_fts_query` (re-exported one level
// up in `fts/mod.rs`).
pub use sanitizer::sanitize_fts_query;

// Result / query-length ceilings.
pub use constants::{MAX_QUERY_LEN, MAX_SEARCH_RESULTS};

// #828 snippet highlight sentinels (re-exported again by `fts` for the MCP
// search tool).
pub use constants::{SNIPPET_HL_CLOSE, SNIPPET_HL_OPEN};

// Shared `content` SELECT-expression builder (used by `toggle_filter`).
pub(in crate::fts) use row::content_select_expr;

// Post-filter cursor pagination (used by `toggle_filter`).
pub(in crate::fts) use post_filter::fts_fetch_post_filtered_page;

// Partitioned scan (used by `toggle_filter` + the `fts` facade).
// `FtsPartitionedScan` is `pub` (widened in #2621, wave S4d) so the app-layer
// partitioned IPC command (`crate::commands::queries`) can read its fields
// across the crate boundary via the `fts` facade re-export.
pub use partitioned::FtsPartitionedScan;
pub(crate) use partitioned::{PALETTE_CONTENT_PREVIEW_CAP, search_fts_partitioned};

// Test-only SQL-prefix accessor (used by `fts/tests.rs`).
#[cfg(test)]
pub(crate) use fetch::fts_select_prefix_for_test;
