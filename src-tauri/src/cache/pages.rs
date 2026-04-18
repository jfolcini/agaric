use sqlx::SqlitePool;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// rebuild_pages_cache (p1-t19)
// ---------------------------------------------------------------------------

/// Full recompute of `pages_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` where
/// `block_type = 'page'` and not soft-deleted.
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding pages cache");
    let start = std::time::Instant::now();
    let result = rebuild_pages_cache_impl(pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt pages cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for pages cache");
            Err(e)
        }
    }
}

async fn rebuild_pages_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;

    let res = sqlx::query!(
        "INSERT INTO pages_cache (page_id, title, updated_at)
         SELECT id, content, ?
         FROM blocks
         WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL
           AND is_conflict = 0",
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

/// Read/write split variant of [`rebuild_pages_cache`].
///
/// Delegates to the single-pool implementation using the write pool
/// for atomic `INSERT INTO ... SELECT`.  The read pool parameter is
/// accepted for API compatibility but unused — see
/// [`rebuild_tags_cache_split`](super::tags::rebuild_tags_cache_split) for rationale.
pub async fn rebuild_pages_cache_split(
    write_pool: &SqlitePool,
    _read_pool: &SqlitePool,
) -> Result<(), AppError> {
    rebuild_pages_cache(write_pool).await
}
