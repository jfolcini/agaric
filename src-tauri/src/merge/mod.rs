//! Three-way merge using diffy.
//!
//! Provides:
//! - `merge_text()` — three-way text merge for a block's content
//! - `create_conflict_copy()` — creates a conflict copy block when merge fails
//! - `resolve_property_conflict()` — LWW for concurrent property changes
//! - `merge_block_text_only()` — text-only merge orchestrator for a single
//!   block's `edit_block` history. Deliberately scoped: callers must
//!   compose property/move/delete-resurrect passes separately (see
//!   `sync_protocol::operations::merge_diverged_blocks`).

mod apply;
mod detect;
mod resolve;
mod types;

#[cfg(test)]
mod tests;

pub use apply::merge_block_text_only;
pub use detect::merge_text;
pub use resolve::{create_conflict_copy, resolve_property_conflict};
pub use types::{MergeOutcome, MergeResult, PropertyConflictResolution};

// Test-only alias: the existing test suite was written against the old
// name `merge_block`. Production callers MUST use `merge_block_text_only`
// so the text-only scope is explicit at the call site (M-73). This alias
// is gated on `cfg(test)` so it cannot leak into production code.
#[cfg(test)]
pub(crate) use apply::merge_block_text_only as merge_block;
