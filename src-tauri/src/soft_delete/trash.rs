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
/// Recursive member filters `deleted_at IS NULL` so already-deleted
/// subtrees keep their original tombstone timestamp. `depth < 100`
/// bounds the walk against runaway recursion on corrupted parent_id
/// chains.
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_ACTIVE`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
///
/// L-101: Emits `tracing::debug!` at entry and `tracing::info!` after
/// the cascade UPDATE so a user-reported "I lost a tree of blocks"
/// triage has a log record of the seed block_id, the cascade size, and
/// the timestamp.
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    _device_id: &str,
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
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at IS NULL",
        block_id,
        now,
    )
    .execute(&mut *tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the soft-delete. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. The standard-variant helper is
    // invariant to whether the cascade has run, so this works post-UPDATE.
    if crate::block_descendants::cascade_depth_saturated(&mut *tx, block_id).await? {
        tracing::warn!(
            seed_block_id = %block_id,
            op = "cascade_soft_delete",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not soft-deleted. Tree is pathologically deep.",
        );
    }

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
