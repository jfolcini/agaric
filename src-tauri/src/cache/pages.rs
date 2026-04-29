use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `pages_cache` has 3 columns per row (page_id, title, updated_at) →
// `MAX_SQL_PARAMS / 3 = 333` rows per chunk. Mirrors the chunk-size
// derivation in `cache/agenda.rs` and `cache/block_tag_refs.rs`.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

// ---------------------------------------------------------------------------
// rebuild_pages_cache (p1-t19)
// ---------------------------------------------------------------------------

/// Full recompute of `pages_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` where
/// `block_type = 'page'` and not soft-deleted.
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || rebuild_pages_cache_impl(pool)).await
}

async fn rebuild_pages_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;

    // `INSERT OR IGNORE` matches the split variant
    // (`rebuild_pages_cache_split_impl`) for semantic equivalence; the
    // preceding `DELETE FROM pages_cache` ensures no PK conflict in
    // practice, but the IGNORE form documents the intent and makes both
    // variants byte-identical at the apply site.
    let res = sqlx::query!(
        "INSERT OR IGNORE INTO pages_cache (page_id, title, updated_at)
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

/// Read/write split variant of [`rebuild_pages_cache`] (M-17).
///
/// Reads the desired page rows from `read_pool` inside a snapshot-
/// isolated transaction, materialises them into memory, then runs the
/// `DELETE FROM pages_cache` plus chunked `INSERT OR IGNORE` on
/// `write_pool` so the writer is held only for the final write
/// transaction.
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks`. The next rebuild
/// reconciles any churn — cache rebuilds are background, eventually
/// consistent (AGENTS.md "Performance Conventions / Split read/write
/// pool pattern").
pub async fn rebuild_pages_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || {
        rebuild_pages_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_pages_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Capture `now` before the read tx so every row in this rebuild
    // shares one `updated_at` timestamp (matches the single-pool
    // variant's semantics).
    let now = crate::now_rfc3339();

    // Read phase — snapshot-isolated SELECT on `read_pool`. Same filters
    // as `rebuild_pages_cache_impl`: `block_type = 'page'`,
    // `is_conflict = 0`, `deleted_at IS NULL`, `content IS NOT NULL`.
    let mut read_tx = read_pool.begin().await?;
    let desired_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content
         FROM blocks
         WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL
           AND is_conflict = 0",
    )
    .fetch_all(&mut *read_tx)
    .await?;
    drop(read_tx);

    // Write phase — DELETE + chunked `INSERT OR IGNORE` on `write_pool`.
    // Mirrors M-18's chunked-INSERT shape so a single statement binds at
    // most `REBUILD_CHUNK * 3 = 999 ≤ MAX_SQL_PARAMS`.
    let mut tx = write_pool.begin().await?;
    sqlx::query!("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    for chunk in desired_rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO pages_cache (page_id, title, updated_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (page_id, title) in chunk {
            q = q.bind(page_id).bind(title).bind(&now);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}
