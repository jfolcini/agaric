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
    let result = sqlx::query(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type) AS ( \
             SELECT b.id, b.id, b.block_type FROM blocks b \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
         ), \
         page_ancestors AS ( \
             SELECT block_id, cur_id AS page_id \
             FROM ancestors \
             WHERE cur_type = 'page' \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT pa.page_id FROM page_ancestors pa WHERE pa.block_id = blocks.id \
         )",
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
