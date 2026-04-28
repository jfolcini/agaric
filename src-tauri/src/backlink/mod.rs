//! Backlink queries: filtered, grouped, and unlinked reference detection.

pub(crate) mod filters;
mod grouped;
mod query;
pub(crate) mod sort;
pub mod types;

#[cfg(test)]
mod tests;

// Re-export public API (must match current surface)
pub use grouped::{eval_backlink_query_grouped, eval_unlinked_references};
pub use query::{eval_backlink_query, list_property_keys};
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
/// one place. (L-82/L-83/L-84)
pub(crate) const SMALL_IN_LIMIT: usize = 500;
