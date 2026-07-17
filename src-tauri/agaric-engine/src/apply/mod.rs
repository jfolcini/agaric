//! The per-op apply kernel (#2621 THE INVERSION).
//!
//! Moved DOWN from the app crate's `materializer::handlers`: the projection
//! kernel that turns one op-log record into the materialised SQL + drives the
//! per-space Loro engine. Split across submodules mirroring the old
//! handler layout:
//!
//! - `kernel`: `apply_op_projected`, `apply_op_tx`, `advance_apply_cursor`,
//!   the `ChunkAccumulator` / `ApplyEffects` types, and the descendant-cohort
//!   collectors (`collect_restore_cohort` / `collect_delete_cohort`).
//! - `loro_apply`: the engine-routed `apply_*_via_loro` handlers + the SQL
//!   purge cascade.
//! - `sql_only`: the `apply_*_sql_only` projection fallbacks.
//! - `pages_cache`: `maintain_pages_cache_counts_after_op` +
//!   `recompute_pages_cache_counts_for_pages` and their helpers.
//! - `attachments`: the three per-op `apply_*_attachment_tx` writers.
//!
//! What STAYS app-side (reaches these through re-export shims at the old
//! `crate::materializer::handlers::…` paths): the `Materializer` coordinator /
//! queue / retry logic, the REMOTE `apply_op` wrapper (observability timer +
//! the `dispatch_*_descendants` post-commit fan-out), the orphaned-attachment
//! GC (`cleanup_orphaned_attachments`), and every `#[tauri::command]` wrapper.
//! The engine stays Tauri-free.
//!
//! Depends on Pieces A+B in `agaric-store` (`rederive_page_and_space_ids`,
//! `cross_space_validation`) plus the sibling engine `loro` / `merge` modules.

// Shared prelude — each submodule pulls it in via `use super::*;`, exactly as
// the app `handlers` module did before the split. Store/core paths replace the
// old `crate::…` ones.
use agaric_core::error::AppError;
use agaric_store::op::{
    AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpType,
    PurgeBlockPayload, RemoveTagPayload, RenameAttachmentPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use agaric_store::op_log::OpRecord;
use agaric_store::tag_inheritance;

pub mod attachments;
pub mod kernel;
pub mod loro_apply;
pub mod pages_cache;
pub mod sql_only;
// #1057 SQL-only fallback observability counter — moved down with the
// `apply_*_via_loro` handlers that record into it (engine-clean: a
// process-global `AtomicU64` + a `tracing::debug!`). The app re-exports
// `count` so the coordinator's status builder keeps reading the same static.
pub mod sql_only_fallback;

// Private glob re-exports so sibling submodules resolve cross-module calls
// through their own `use super::*;` (e.g. `kernel::apply_op_tx` calling
// `loro_apply::apply_create_block_via_loro` or `pages_cache::maintain_…`).
// All item names are unique across submodules, so the globs never collide.
use attachments::*;
use kernel::*;
use loro_apply::*;
use pages_cache::*;
use sql_only::*;
