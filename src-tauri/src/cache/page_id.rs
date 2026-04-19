//! Rebuild the denormalized `page_id` column on `blocks`.

use crate::error::AppError;
use sqlx::SqlitePool;

/// Full rebuild of `page_id` for all blocks using a recursive CTE.
pub async fn rebuild_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding page_id cache");
    let start = std::time::Instant::now();
    match rebuild_page_ids_impl(pool).await {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt page_id cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for page_id cache");
            Err(e)
        }
    }
}

async fn rebuild_page_ids_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Invariant #9: recursive CTE over `blocks` must filter `is_conflict = 0`
    // in both members and bound `depth < 100`. Conflict copies share
    // `parent_id` with the original and must not be walked through (or the
    // rebuild would compute a page ancestor via the original's parent chain,
    // then rewrite `page_id` — which is exactly the bug fixed here). Their
    // `page_id` is assigned at conflict-creation time and must be preserved
    // by the rebuild.
    let result = sqlx::query(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
             SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
             WHERE b.is_conflict = 0 \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type, a.depth + 1 \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
               AND child.is_conflict = 0 \
               AND parent.is_conflict = 0 \
               AND a.depth < 100 \
         ), \
         page_ancestors AS ( \
             SELECT block_id, cur_id AS page_id \
             FROM ancestors \
             WHERE cur_type = 'page' \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT pa.page_id FROM page_ancestors pa WHERE pa.block_id = blocks.id \
         ) \
         WHERE is_conflict = 0",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Split variant for read/write pool separation.
pub async fn rebuild_page_ids_split(
    write_pool: &SqlitePool,
    _read_pool: &SqlitePool,
) -> Result<(), AppError> {
    rebuild_page_ids(write_pool).await
}
