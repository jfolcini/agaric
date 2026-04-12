//! Three-way merge using diffy.
//!
//! Provides:
//! - `merge_text()` — three-way text merge for a block's content
//! - `create_conflict_copy()` — creates a conflict copy block when merge fails
//! - `resolve_property_conflict()` — LWW for concurrent property changes
//! - `merge_block()` — high-level merge orchestrator for a single block

mod apply;
mod detect;
mod resolve;
mod types;

#[cfg(test)]
mod tests;

pub use apply::merge_block;
pub use detect::merge_text;
pub use resolve::{create_conflict_copy, resolve_property_conflict};
pub use types::{MergeOutcome, MergeResult, PropertyConflictResolution};
