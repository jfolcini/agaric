//! Extracted handler functions for the materializer queues.
//!
//! #644: this module was split from a single ~4.9K-line `handlers.rs`
//! into per-responsibility submodules. The split is a pure move — every
//! function body, SQL string, and `// dynamic-sql:` justification is
//! verbatim from the original file; the only edits are the `mod`/`use`
//! plumbing here and the `pub(super)` visibility raises that let the
//! submodules call one another. The shared imports below are pulled into
//! each submodule via `use super::*;`, and the cross-submodule call graph
//! resolves through the private `use <submod>::*;` glob re-exports here.
//!
//! Submodules:
//! - `task_handlers`: foreground/background queue task dispatch.
//! - `apply`: the per-op apply transaction, apply cursor, gcal deferred
//!   notifications, and Restore/Delete cascade fan-out + cohort collectors.
//! - `pages_cache`: PEND-56b `pages_cache.{inbound_link_count,
//!   child_block_count}` maintenance (the canonical recompute SELECT).
//! - `loro_apply`: engine-routed `apply_*_via_loro` + the SQL purge cascade.
//! - `sql_only`: the `apply_*_sql_only` projection fallbacks.
//! - `attachments`: attachment apply handlers + orphan-cleanup (C-3c).

use super::MaterializeTask;
use super::dirty_sink::{DirtyNotification, DirtySink};
use crate::cache;
use crate::error::AppError;
use crate::fts;
use crate::op::{
    AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpType,
    PurgeBlockPayload, RemoveTagPayload, RenameAttachmentPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::tag_inheritance;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

mod apply;
mod attachments;
mod loro_apply;
mod pages_cache;
mod sql_only;
mod task_handlers;

// Private glob re-exports so sibling submodules can resolve cross-module
// calls through their own `use super::*;` (e.g. `apply::apply_op_tx`
// calling `loro_apply::apply_create_block_via_loro`). All item names are
// unique across submodules, so the globs never collide.
use apply::*;
use attachments::*;
use loro_apply::*;
use pages_cache::*;
use sql_only::*;

// External re-exports — preserve the pre-split paths so callers outside
// this module (materializer/mod.rs, consumer.rs, tests.rs) do not change.
pub(crate) use attachments::cleanup_orphaned_attachments;
pub(crate) use pages_cache::recompute_pages_cache_counts_for_pages;
pub(crate) use task_handlers::{handle_background_task, handle_foreground_task};

#[cfg(test)]
mod delete_cascade_tests;
#[cfg(test)]
mod engine_path_tests;
#[cfg(test)]
mod move_sql_only_cycle_tests;
#[cfg(test)]
mod restore_cascade_tests;
#[cfg(test)]
mod sibling_order_full_apply_603_tests;
#[cfg(test)]
mod static_source_checks;
