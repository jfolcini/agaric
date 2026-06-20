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
//! - `apply`: the per-op apply transaction, apply cursor, and
//!   Restore/Delete cascade fan-out + cohort collectors.
//!   `pages_cache`: `pages_cache.{inbound_link_count,
//!   child_block_count}` maintenance (the canonical recompute SELECT).
//! - `loro_apply`: engine-routed `apply_*_via_loro` + the SQL purge cascade.
//! - `sql_only`: the `apply_*_sql_only` projection fallbacks.
//! - `attachments`: attachment apply handlers + orphan-cleanup (C-3c).

use super::MaterializeTask;
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
use std::sync::Arc;

mod apply;
mod attachments;
mod loro_apply;
mod pages_cache;
mod sql_only;
pub(crate) mod sql_only_fallback;
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
// #1257 the LOCAL create_block command path drives the engine-apply +
// dense-position projection through this helper IN-TRANSACTION (without
// advancing the apply cursor — that stays a boot-replay / dispatch_op concern),
// so a fresh local create is engine-fresh and densely-positioned immediately
// instead of waiting for the next boot replay (#1245 / #1249).
pub(crate) use loro_apply::apply_create_block_via_loro;
// #1257 the LOCAL edit_block / set_property / delete_property / add_tag /
// remove_tag command paths drive their engine-apply + projection (and tag
// inheritance fan-out for add/remove_tag) through these helpers IN-TRANSACTION,
// without advancing the apply cursor (boot-replay re-applies idempotently — the
// safety net). None touch `position`, so there is no dense-reprojection step.
pub(crate) use loro_apply::{
    apply_add_tag_via_loro, apply_delete_property_via_loro, apply_edit_block_via_loro,
    apply_remove_tag_via_loro, apply_set_property_via_loro,
};
// #1257 the LOCAL move_block command path drives the engine-move +
// dense-position reprojection (of BOTH the source and target sibling groups)
// through this helper IN-TRANSACTION (without advancing the apply cursor — that
// stays a boot-replay / dispatch_op concern), so a fresh local move is
// engine-fresh and densely-positioned in both parents immediately instead of
// waiting for the next boot replay (#1245 / #1249).
pub(crate) use loro_apply::apply_move_block_via_loro;
// #1257 the LOCAL delete / restore / purge command paths PRE-CAPTURE each
// root's subtree COHORT + SPACE below the SQL soft-delete (these collectors)
// and then drive the captured cohort onto the per-space Loro engine via the
// post-commit fan-out (`dispatch_*_descendants`) — mirroring `apply_op_tx` +
// `apply_op`. The cohort + space MUST be captured before the SQL UPDATE (else a
// post-delete `resolve_block_space` returns None → the engine misses the
// cascade → the #1257 phantom). The apply cursor stays put (boot-replay /
// `dispatch_op` concern only). The `apply_*_via_loro` CASCADE helpers are also
// raised to `pub(crate)` at their definitions (consumed crate-internally via
// the `use loro_apply::*` glob below) so they sit on the same engine-apply
// Surface established; the multi-root command path itself routes the
// engine through the fan-out + `merge::engine_apply` rather than the per-seed
// helper (the helper's single-root SQL projection would double-count the
// multi-root cascade; a post-cascade call hits dead space resolution).
pub(crate) use apply::{
    collect_delete_cohort, collect_restore_cohort, dispatch_delete_descendants,
    dispatch_restore_descendants,
};
pub(crate) use pages_cache::recompute_pages_cache_counts_for_pages;
pub(crate) use task_handlers::{handle_background_task, handle_foreground_task};

#[cfg(test)]
mod apply_reproject_proptest;
#[cfg(test)]
mod create_edit_convergence_tests;
#[cfg(test)]
mod delete_cascade_tests;
#[cfg(test)]
mod delete_restore_convergence_tests;
#[cfg(test)]
mod engine_path_tests;
#[cfg(test)]
mod move_convergence_tests;
#[cfg(test)]
mod move_sql_only_cycle_tests;
#[cfg(test)]
mod restore_cascade_tests;
#[cfg(test)]
mod sibling_order_full_apply_603_tests;
#[cfg(test)]
mod static_source_checks;
#[cfg(test)]
mod tag_convergence_tests;
