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
