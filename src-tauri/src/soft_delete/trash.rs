//! Soft-delete: `soft_delete_block`, `cascade_soft_delete`.

use sqlx::SqlitePool;

use crate::error::AppError;

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
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    tracing::debug!(seed_block_id = %block_id, "cascade soft-delete starting");
    let now = crate::now_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

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
