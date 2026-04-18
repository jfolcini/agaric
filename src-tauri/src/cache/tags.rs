use sqlx::SqlitePool;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// rebuild_tags_cache (p1-t18)
// ---------------------------------------------------------------------------

/// Full recompute of `tags_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` (type = `tag`)
/// left-joined with `block_tags` usage counts. Tags with zero usage are
/// included.
pub async fn rebuild_tags_cache(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding tags cache");
    let start = std::time::Instant::now();
    let result = rebuild_tags_cache_impl(pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt tags cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for tags cache");
            Err(e)
        }
    }
}

async fn rebuild_tags_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;

    let res = sqlx::query!(
        "INSERT OR IGNORE INTO tags_cache (tag_id, name, usage_count, updated_at)
         SELECT b.id, b.content, COALESCE(t.cnt, 0), ?
         FROM blocks b
         LEFT JOIN (
             SELECT bt.tag_id, COUNT(*) AS cnt
             FROM block_tags bt
             JOIN blocks blk ON blk.id = bt.block_id
             WHERE blk.deleted_at IS NULL
             GROUP BY bt.tag_id
         ) t ON t.tag_id = b.id
         WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL
           AND b.is_conflict = 0
         ORDER BY b.id",
        now,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(res.rows_affected())
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_tags_cache`].
///
/// Delegates to the single-pool implementation using the write pool
/// for atomic `INSERT INTO ... SELECT`.  The read pool parameter is
/// accepted for API compatibility but unused — holding the write pool
/// for the combined SELECT+INSERT is acceptable because cache rebuilds
/// are background stale-while-revalidate operations, not latency-critical.
pub async fn rebuild_tags_cache_split(
    write_pool: &SqlitePool,
    _read_pool: &SqlitePool,
) -> Result<(), AppError> {
    rebuild_tags_cache(write_pool).await
}
