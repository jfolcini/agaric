//! Incremental maintenance of the `block_tag_inherited` cache table (P-4).
//!
//! The table stores inherited tag relationships: when a block has a tag in
//! `block_tags`, all its non-deleted descendants inherit that tag. This module
//! provides helpers for incremental updates (called from command handlers and
//! `apply_op`) and a full rebuild (background safety net).
//!
//! ## Recursive CTE policy (invariant #9)
//!
//! Every CTE that walks descendants via `parent_id` in this module filters
//! `is_conflict = 0` in the recursive member. Exception: `remove_subtree_inherited`
//! deliberately does NOT filter `deleted_at` or `is_conflict` — it is called
//! AFTER the blocks have been soft-deleted, so filtering `deleted_at IS NULL`
//! would miss the very rows we need to clean up. The `is_conflict` omission
//! is intentional for the same reason: conflict-copy descendants' inherited
//! entries must also be swept when the owning subtree is deleted. See the
//! per-function doc comments for the specific rationale.
//!
//! Every recursive CTE in this module is built from the macro family in
//! [`crate::tag_inheritance_macros`] (MAINT-141). The macros bake in
//! invariant #9 (`is_conflict = 0` filter, `subtree_unfiltered` excepted)
//! and the [`crate::tag_inheritance_macros::MAX_TAG_INHERITANCE_DEPTH`]
//! depth bound. Do **not** hand-roll a new `WITH RECURSIVE` block here —
//! extend the macro family instead.
//!
//! Use [`apply_op_tag_inheritance`] as the single entry point for materializer
//! handlers — MAINT-45. Adding a new op type that affects inheritance only
//! requires extending the match in that one place.

mod incremental;
mod rebuild;
#[cfg(test)]
mod tests;

use sqlx::SqliteConnection;

use crate::error::AppError;
use crate::op::OpPayload;

// MAINT-142: helpers are `pub(crate)` because the documented single entry
// point is `apply_op_tag_inheritance`. Pre-existing in-crate call-sites
// (commands/blocks/crud.rs, commands/blocks/move_ops.rs, commands/tags.rs,
// materializer/handlers.rs) continue to invoke specific helpers directly
// via these re-exports.
pub(crate) use incremental::{
    inherit_parent_tags, propagate_tag_to_descendants, recompute_subtree_inheritance,
    remove_inherited_tag, remove_subtree_inherited,
};
pub(crate) use rebuild::rebuild_all_split;
// `rebuild_all` is also called from `benches/tag_query_bench.rs`, which
// links the crate as an external dependency, so it must stay `pub`.
pub use rebuild::rebuild_all;

/// Dispatch inheritance updates for a single op payload.
///
/// This is the **single entry point** that the materializer and command
/// handlers use to keep `block_tag_inherited` in sync after an op lands.
/// Having one place for the fan-out prevents the class of drift MAINT-45
/// calls out: adding a new op type now requires exactly one match arm
/// here, and the compiler will point at it if the enum changes.
///
/// Ops that have no inheritance side-effect (EditBlock, SetProperty,
/// AddAttachment, PurgeBlock — purge handles inheritance inline via its
/// cascade DELETE) return Ok(()) as no-ops.
pub async fn apply_op_tag_inheritance(
    conn: &mut SqliteConnection,
    payload: &OpPayload,
) -> Result<(), AppError> {
    match payload {
        OpPayload::CreateBlock(p) => {
            let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
            inherit_parent_tags(conn, p.block_id.as_str(), parent).await
        }
        OpPayload::DeleteBlock(p) => remove_subtree_inherited(conn, p.block_id.as_str()).await,
        OpPayload::RestoreBlock(p) => {
            recompute_subtree_inheritance(conn, p.block_id.as_str()).await
        }
        OpPayload::MoveBlock(p) => recompute_subtree_inheritance(conn, p.block_id.as_str()).await,
        OpPayload::AddTag(p) => {
            propagate_tag_to_descendants(conn, p.block_id.as_str(), p.tag_id.as_str()).await
        }
        OpPayload::RemoveTag(p) => {
            remove_inherited_tag(conn, p.block_id.as_str(), p.tag_id.as_str()).await
        }
        // No inheritance side effect:
        //  - EditBlock / SetProperty / DeleteProperty: tag membership unchanged
        //  - AddAttachment / DeleteAttachment: attachments don't inherit tags
        //  - PurgeBlock: cascade DELETE in materializer handles block_tag_inherited rows
        OpPayload::EditBlock(_)
        | OpPayload::SetProperty(_)
        | OpPayload::DeleteProperty(_)
        | OpPayload::AddAttachment(_)
        | OpPayload::DeleteAttachment(_)
        | OpPayload::PurgeBlock(_) => Ok(()),
    }
}
