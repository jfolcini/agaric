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
    super::rebuild_with_timing("tags", || rebuild_tags_cache_impl(pool)).await
}

async fn rebuild_tags_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;

    // UX-250: usage_count counts DISTINCT block_ids from the UNION of
    // `block_tags` (explicit associations) and `block_tag_refs` (inline
    // `#[ULID]` references in content). Both joins enforce
    // `deleted_at IS NULL AND is_conflict = 0` on the referenced block
    // so soft-deleted / conflict-copy blocks never contribute.
    //
    // UNION (not UNION ALL) collapses a block that happens to carry both
    // an explicit tag AND an inline ref to the same tag into a single
    // entry — the user sees one reference, not two.
    //
    // Tags with zero usage remain in the cache via the LEFT JOIN; the
    // COALESCE falls back to 0.
    let res = sqlx::query!(
        "INSERT OR IGNORE INTO tags_cache (tag_id, name, usage_count, updated_at)
         SELECT b.id, b.content, COALESCE(t.cnt, 0), ?
         FROM blocks b
         LEFT JOIN (
             SELECT tag_id, COUNT(*) AS cnt FROM (
                 SELECT bt.tag_id, bt.block_id
                 FROM block_tags bt
                 JOIN blocks blk ON blk.id = bt.block_id
                 WHERE blk.deleted_at IS NULL AND blk.is_conflict = 0
                 UNION
                 SELECT btr.tag_id, btr.source_id AS block_id
                 FROM block_tag_refs btr
                 JOIN blocks blk ON blk.id = btr.source_id
                 WHERE blk.deleted_at IS NULL AND blk.is_conflict = 0
             )
             GROUP BY tag_id
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
