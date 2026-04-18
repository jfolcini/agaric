//! Restore: `restore_block`.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// Recursive member filters `is_conflict = 0` — conflict copies have
/// independent lifecycles and must not be bulk-restored with the original
/// (invariant #9). `depth < 100` bounds the walk.
pub async fn restore_block(
    pool: &SqlitePool,
    block_id: &str,
    deleted_at_ref: &str,
) -> Result<u64, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.is_conflict = 0 AND d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
        block_id,
        deleted_at_ref,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(result.rows_affected())
}
