use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `tags_cache` has 4 columns per row (tag_id, name, usage_count,
// updated_at) → `MAX_SQL_PARAMS / 4 = 249` rows per chunk. Mirrors the
// chunk-size derivation in `cache/agenda.rs` and `cache/block_tag_refs.rs`.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 4; // 249

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

/// Read/write split variant of [`rebuild_tags_cache`] (M-17).
///
/// Reads the desired tag rows from `read_pool` inside a snapshot-isolated
/// transaction, materialises them into memory, then runs the
/// `DELETE FROM tags_cache` plus chunked `INSERT OR IGNORE` on
/// `write_pool` so the writer is held only for the final write
/// transaction.
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks`/`block_tags`/
/// `block_tag_refs`. The next rebuild reconciles any churn — cache
/// rebuilds are background, eventually consistent (AGENTS.md
/// "Performance Conventions / Split read/write pool pattern").
pub async fn rebuild_tags_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || {
        rebuild_tags_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_tags_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Capture `now` before the read tx so every row in this rebuild
    // shares one `updated_at` timestamp (matches the single-pool
    // variant's semantics).
    let now = crate::now_rfc3339();

    // Read phase — snapshot-isolated SELECT on `read_pool`. Same shape
    // and filters as `rebuild_tags_cache_impl`: UX-250 UNION over
    // `block_tags` ∪ `block_tag_refs`, `is_conflict = 0`,
    // `deleted_at IS NULL`, `content IS NOT NULL`. Tags with zero usage
    // are included via the LEFT JOIN + COALESCE.
    let mut read_tx = read_pool.begin().await?;
    let desired_rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT b.id, b.content, COALESCE(t.cnt, 0) AS cnt
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
    )
    .fetch_all(&mut *read_tx)
    .await?;
    drop(read_tx);

    // Write phase — DELETE + chunked `INSERT OR IGNORE` on `write_pool`.
    // Mirrors M-18's chunked-INSERT shape so a single statement binds at
    // most `REBUILD_CHUNK * 4 = 996 ≤ MAX_SQL_PARAMS`.
    let mut tx = write_pool.begin().await?;
    sqlx::query!("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    for chunk in desired_rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (tag_id, name, usage_count) in chunk {
            q = q.bind(tag_id).bind(name).bind(usage_count).bind(&now);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}
