//! Soft-delete: `soft_delete_block`, `cascade_soft_delete`.

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::{MoveBlockPayload, OpPayload};
use crate::op_log::append_local_op_in_tx;
use crate::ulid::BlockId;

/// Soft-delete a single block (no cascade).
pub async fn soft_delete_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Option<String>, AppError> {
    let now = crate::now_rfc3339();
    let result = sqlx::query!(
        "UPDATE blocks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        now,
        block_id
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        Ok(None)
    } else {
        Ok(Some(now))
    }
}

/// Cascade soft-delete: sets `deleted_at` on the block and all non-deleted
/// descendants via recursive CTE.
///
/// Recursive member filters `is_conflict = 0` — conflict copies share
/// their original's parent_id but have independent lifecycles and must
/// not be swept into the cascade (invariant #9). `depth < 100` bounds
/// the walk against runaway recursion on corrupted parent_id chains.
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_ACTIVE`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
///
/// L-101: Emits `tracing::debug!` at entry and `tracing::info!` after
/// the cascade UPDATE so a user-reported "I lost a tree of blocks"
/// triage has a log record of the seed block_id, the cascade size, and
/// the timestamp. `compact_op_log` is fully instrumented; cascade
/// delete (which can sweep thousands of blocks in one tx) was opaque.
///
/// M-81: Before applying the cascade UPDATE, re-parent any conflict copy
/// whose `parent_id` lives inside the doomed subtree. Conflict copies are
/// excluded from the cascade by invariant #9, so without the re-parent
/// step they would be left pointing into a soft-deleted ancestor — a
/// semi-orphan that is reachable by id but invisible to any descendants
/// walk. The re-parent walks the parent chain via `ancestors_cte_active!`,
/// picks the nearest ancestor outside the subtree, and emits one
/// `MoveBlock` op log entry per re-parent so peers replay the repair via
/// normal sync. If no live, non-conflict ancestor exists the conflict
/// copy is set to `parent_id = NULL` (top-level orphan, visible in the
/// conflicts view). Each re-parent is logged at `tracing::warn` level
/// with conflict-copy id, the deleted ancestor id, and the new parent.
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    tracing::debug!(seed_block_id = %block_id, "cascade soft-delete starting");
    let now = crate::now_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // M-81: re-parent orphan conflict copies BEFORE the cascade UPDATE so
    // the ancestor walk reads the pre-cascade `deleted_at` state of the
    // subtree. After the cascade UPDATE every subtree row has
    // `deleted_at IS NOT NULL`, which would make `ancestors_cte_active!`
    // (filters `b.deleted_at IS NULL`) terminate at depth 0. Doing the
    // walk first keeps the macro reusable instead of hand-rolling a new
    // walk. Both halves run inside this `BEGIN IMMEDIATE` tx so a
    // failure rolls back atomically.
    reparent_orphan_conflict_copies(&mut tx, device_id, block_id, &now).await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at IS NULL",
        block_id,
        now,
    )
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;
    tracing::info!(
        seed_block_id = %block_id,
        descendants_marked = count,
        deleted_at = %now,
        "cascade soft-delete"
    );
    Ok((now, count))
}

/// M-81: re-parent every conflict copy whose `parent_id` is in the
/// soon-to-be-deleted cascade subtree, emit one `MoveBlock` op per
/// re-parent, and log each at `warn` level.
///
/// Runs inside the cascade transaction *before* the cascade UPDATE so the
/// pre-cascade `deleted_at IS NULL` state of subtree members lets
/// `ancestors_cte_active!` traverse the chain freely. The first ancestor
/// outside the subtree (computed in Rust against the descendants set) is
/// the new parent; if no such ancestor exists the conflict copy floats to
/// `parent_id = NULL`.
///
/// The MoveBlock op preserves the conflict copy's current `position` —
/// we are repairing the parent pointer, not re-ordering siblings.
///
/// Visibility: `pub(crate)` so the production write path
/// `commands::blocks::crud::delete_block_inner` (which runs its own
/// inline cascade UPDATE rather than calling `cascade_soft_delete`) can
/// invoke the same repair step. The two cascade sites share this
/// helper to keep the re-parent semantics in one place.
pub(crate) async fn reparent_orphan_conflict_copies(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    seed_block_id: &str,
    now: &str,
) -> Result<u64, AppError> {
    // Step 1 — find conflict copies whose `parent_id` is in the cascade
    // subtree. The subtree is the seed plus every non-deleted, non-conflict
    // descendant — exactly the set the cascade UPDATE will mark, computed
    // via `descendants_cte_active!()` (invariant #9: `is_conflict = 0`
    // recursive filter + `depth < 100` bound).
    let orphans: Vec<(String, String, Option<i64>)> = sqlx::query_as(concat!(
        crate::descendants_cte_active!(),
        "SELECT c.id, c.parent_id, c.position FROM blocks c \
         WHERE c.is_conflict = 1 \
           AND c.deleted_at IS NULL \
           AND c.parent_id IN (SELECT id FROM descendants)",
    ))
    .bind(seed_block_id)
    .fetch_all(&mut **tx)
    .await?;

    if orphans.is_empty() {
        return Ok(0);
    }

    // Step 2 — materialise the subtree id set so the per-orphan ancestor
    // walks below can filter "outside the cascade" entirely in Rust. One
    // SQL round trip instead of one per orphan.
    let subtree_ids: HashSet<String> = sqlx::query_scalar(concat!(
        crate::descendants_cte_active!(),
        "SELECT id FROM descendants",
    ))
    .bind(seed_block_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();

    let mut count: u64 = 0;
    for (conflict_id, old_parent_id, position) in orphans {
        // Step 3 — walk the parent chain via the canonical
        // `ancestors_cte_active!()` macro (invariant #9: filters
        // `b.is_conflict = 0` AND `b.deleted_at IS NULL` in the recursive
        // member, bounds `a.depth < 100`). Seeded at the orphan's current
        // parent_id — pre-cascade every subtree ancestor is alive and
        // non-conflict, so the walk traverses the whole chain up to the
        // first pre-existing-deleted-or-conflict block (or the root).
        // The first ancestor NOT in the subtree is our new parent.
        let chain: Vec<String> = sqlx::query_scalar(concat!(
            crate::ancestors_cte_active!(),
            "SELECT id FROM ancestors ORDER BY depth",
        ))
        .bind(&old_parent_id)
        .fetch_all(&mut **tx)
        .await?;

        let new_parent_id: Option<String> = chain.into_iter().find(|id| !subtree_ids.contains(id));

        // Step 4 — apply the re-parent locally. `parent_id` is nullable in
        // the schema (see `migrations/0001_initial.sql:9`), so the FK
        // constraint with `PRAGMA foreign_keys = ON` is satisfied for both
        // a non-null re-parent target and the NULL "top-level orphan"
        // case.
        sqlx::query!(
            "UPDATE blocks SET parent_id = ? WHERE id = ?",
            new_parent_id,
            conflict_id,
        )
        .execute(&mut **tx)
        .await?;

        // Step 5 — emit the matching `MoveBlock` op so peers replay the
        // repair via sync. Same op shape that `move_block_inner` would
        // emit for an explicit user move; the materializer's `MoveBlock`
        // handler writes `parent_id` + `position` on apply, so we carry
        // the conflict copy's current position through the payload to
        // avoid reordering its siblings on replay. Reuses the existing
        // `MoveBlock` variant per AGENTS.md "Architectural Stability"
        // (no new op type).
        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(&conflict_id),
            new_parent_id: new_parent_id.as_deref().map(BlockId::from_trusted),
            new_position: position.unwrap_or(1),
        });
        append_local_op_in_tx(tx, device_id, payload, now.to_string()).await?;

        tracing::warn!(
            conflict_copy_id = %conflict_id,
            deleted_ancestor_id = %old_parent_id,
            new_parent_id = ?new_parent_id,
            "M-81: re-parented conflict copy whose parent is in cascade soft-delete subtree"
        );

        count += 1;
    }

    Ok(count)
}
