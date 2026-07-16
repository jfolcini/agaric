//! Backlink queries: filtered, grouped, and unlinked reference detection.

pub(crate) mod filters;
mod grouped;
pub(crate) mod projection;
mod query;
pub(crate) mod sort;
pub mod types;

#[cfg(test)]
mod tests;

// Re-export public API (must match current surface)
pub use grouped::{eval_backlink_query_grouped, eval_unlinked_references};
pub use query::{eval_backlink_query, list_property_keys, list_property_values};
pub use types::*;

/// Threshold for switching from positional `IN (?,?,…)` placeholder binding
/// to the `IN (SELECT value FROM json_each(?))` fallback.
///
/// SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 in older builds; we
/// cap at 500 to leave headroom for other binds in the same statement and
/// to stay below every realistic upstream limit. Above this threshold we
/// pack the IDs into a single JSON-array bind and let SQLite expand them
/// through `json_each`. Shared by `backlink::sort`, `backlink::query`,
/// `backlink::grouped`, and `backlink::filters` so the threshold lives in
/// One place.
pub(crate) const SMALL_IN_LIMIT: usize = 500;

/// Vault-wide ceiling on the number of FTS-matched block ids a single
/// backlink/unlinked-references query materialises into memory.
///
/// `eval_unlinked_references` (`grouped.rs`) has always capped its trigram
/// scan at this many rows (querying `LIMIT FTS_ROW_CAP + 1` to detect
/// truncation). #672 — the `Contains` filter resolver (`filters.rs`) ran the
/// same kind of trigram `MATCH` with NO limit, so a short common token could
/// materialise every matching id into a `FxHashSet` (and, downstream, a JSON
/// bind). Both sites now share this constant so the cap can never drift.
pub(crate) const FTS_ROW_CAP: usize = 10_000;

/// Per-group ceiling on the number of backlink blocks materialised and
/// fetched for a single source page in the grouped/unlinked responses.
///
/// #380: the grouped paths paginate on *groups* (source pages) but placed
/// no cap on the blocks *within* a group, so one busy source page could
/// force `fetch_block_rows_by_ids` to load thousands of rows for a single
/// group. The vault-wide FTS ceiling is `FTS_ROW_CAP = 10_000`
/// (`grouped.rs`); this per-group cap is two orders of magnitude smaller
/// because it bounds a *single* page's contribution, not the whole match
/// set. 200 comfortably exceeds the number of backlink rows a desktop UI
/// renders for one source page before the reader scrolls (the group list
/// itself is paginated), while keeping the per-query fetch + render cost
/// bounded. When a group is truncated its `BacklinkGroup::truncated` flag
/// is set so the UI can surface "showing first 200" affordances; the
/// response-level `total_count` / `filtered_count` are still counted
/// BEFORE truncation so the badges stay accurate.
pub(crate) const MAX_BLOCKS_PER_GROUP: usize = 200;
