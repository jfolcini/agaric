//! Op-log compaction: purge ops past the retention window and record the
//! frontier the purge ran to.
//!
//! # No snapshot blob (#4699)
//!
//! This module used to build a zstd-CBOR dump of every derived SQL table
//! (`blocks`, `block_tags`, `block_properties`, …) into `log_snapshots` on
//! each compaction, and could restore one over a wiped database. #3487 removed
//! the last production reader; #4699 removed the blob. It duplicated the
//! DERIVED view rather than `loro_doc_state` — the merge truth `db::recovery`
//! reprojects that view from — and building it buffered the whole vault in
//! memory, against Android's ~24 MB release heap.
//!
//! What is left is the purge, plus the single `compaction_watermark` row
//! recording the frontier it reached. Only that row's EXISTENCE is read, by
//! [`agaric_engine::dag::find_lca`], to report a chain broken by compaction as
//! such instead of as a plain `NotFound`.
//!
//! The purge is worth its keep: `op_log` costs ~303 B/op against a materially
//! smaller Loro copy of the same edits, so it is the dominant term in vault
//! growth (#4700).

mod create;

pub use create::{DEFAULT_RETENTION_DAYS, collect_frontier, compact_op_log};

// #3120: repatriated from the app crate.
#[cfg(test)]
mod tests;
