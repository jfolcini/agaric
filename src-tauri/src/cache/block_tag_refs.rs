//! `block_tag_refs` — derived-state cache for inline `#[ULID]` tag
//! references found inside block content (UX-250 Option A).
//!
//! Mirrors the shape of `block_links` but:
//! - scans for `#[ULID]` tokens via [`super::tag_ref_re`]
//! - only inserts rows whose target is actually a `tag` block
//!   (stray IDs that happen to match the regex but point at content/page
//!   blocks are filtered out on INSERT)
//! - explicit tag associations remain in `block_tags`; inline references
//!   stay here so the explicit-vs-inline origin is preserved.  Readers
//!   that want "any kind of reference" UNION the two tables.

use sqlx::SqlitePool;
use std::collections::HashSet;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// block_tag_refs has 2 columns per row.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

// ---------------------------------------------------------------------------
// reindex_block_tag_refs (per-block, incremental)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_tag_refs` for a single block.
///
/// 1. Read the block's current content (single transaction, consistent
///    snapshot).
/// 2. Parse all `#[ULID]` tokens via [`super::tag_ref_re`].
/// 3. Diff against existing rows; DELETE removed, INSERT added.
///
/// Guards: INSERTs use `WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?
/// AND block_type = 'tag')` so only actual tag blocks land in the table.
/// A stray `#[ULID]` pointing at a content/page block produces no row.
///
/// Soft-deleted or purged tags produce no INSERT — but a pre-existing
/// row whose tag gets purged stays (FK ON DELETE CASCADE handles it at
/// purge time). Soft-deleted source blocks clear their rows as their
/// content is unreadable under the `WHERE deleted_at IS NULL` filter.
pub async fn reindex_block_tag_refs(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
        block_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found, deleted, or a conflict copy — remove all rows.
        None => String::new(),
    };

    let new_targets: HashSet<String> = super::tag_ref_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    let existing_rows = sqlx::query!(
        "SELECT tag_id FROM block_tag_refs WHERE source_id = ?",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.tag_id).collect();

    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — transaction rolls back on drop (no commit needed).
        return Ok(());
    }

    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }

    for target in &to_insert {
        let t = *target;
        // INSERT ... SELECT ... WHERE EXISTS — only link to blocks that
        // are actually tags. Non-tag candidates (stray IDs that happen to
        // match the regex but point at content/page blocks) are silently
        // dropped. `INSERT OR IGNORE` handles the already-present case
        // if two insert passes race (shouldn't happen inside a tx, but
        // keeps the statement idempotent).
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, ? WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = ? AND block_type = 'tag')",
            block_id,
            t,
            t,
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`reindex_block_tag_refs`].
///
/// Reads content and existing rows from `read_pool`; diffs and applies
/// inserts/deletes on `write_pool`. Matches the shape of
/// [`super::reindex_block_links_split`].
pub async fn reindex_block_tag_refs_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    // Read phase from read_pool.
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
        block_id,
    )
    .fetch_optional(read_pool)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        None => String::new(),
    };

    let new_targets: HashSet<String> = super::tag_ref_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    let existing_rows = sqlx::query!(
        "SELECT tag_id FROM block_tag_refs WHERE source_id = ?",
        block_id,
    )
    .fetch_all(read_pool)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.tag_id).collect();

    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        return Ok(());
    }

    // Write phase on write_pool.
    let mut tx = write_pool.begin().await?;
    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }
    for target in &to_insert {
        let t = *target;
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, ? WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = ? AND block_type = 'tag')",
            block_id,
            t,
            t,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_block_tag_refs_cache — full recompute
// ---------------------------------------------------------------------------

/// Full recompute of `block_tag_refs`.
///
/// Scans every non-deleted, non-conflict block's content, extracts
/// `#[ULID]` tokens, filters to candidates that are real tag blocks,
/// then DELETE + chunked INSERT replaces the whole table atomically.
///
/// Intended for: migration backfill, snapshot restore, explicit "rebuild
/// caches" actions. Per-block content edits go through
/// [`reindex_block_tag_refs`] instead.
pub async fn rebuild_block_tag_refs_cache(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding block_tag_refs cache");
    let start = std::time::Instant::now();
    let result = rebuild_block_tag_refs_cache_impl(pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt block_tag_refs cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for block_tag_refs cache");
            Err(e)
        }
    }
}

async fn rebuild_block_tag_refs_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Read phase (inside the same tx so we observe a consistent snapshot
    // across the DELETE and the INSERTs).
    let mut tx = pool.begin().await?;

    let tag_ids: HashSet<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    let source_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
    )
    .fetch_all(&mut *tx)
    .await?;

    let re = super::tag_ref_re();
    // Deduplicate via HashSet so adjacent / repeated `#[ULID]` tokens
    // collapse into a single row per (source, tag) pair.
    let mut rows: HashSet<(String, String)> = HashSet::new();
    for row in &source_rows {
        let content = row.content.as_deref().unwrap_or("");
        for cap in re.captures_iter(content) {
            let tag_id = cap[1].to_string();
            if tag_ids.contains(&tag_id) {
                rows.insert((row.id.clone(), tag_id));
            }
        }
    }

    sqlx::query!("DELETE FROM block_tag_refs")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    let rows_vec: Vec<(String, String)> = rows.into_iter().collect();
    for chunk in rows_vec.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}

/// Read/write split variant of [`rebuild_block_tag_refs_cache`].
///
/// Read phase (tag IDs + block content) runs against `read_pool`; the
/// final DELETE + chunked INSERT transaction runs on `write_pool`.
pub async fn rebuild_block_tag_refs_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    tracing::info!("rebuilding block_tag_refs cache");
    let start = std::time::Instant::now();
    let result = rebuild_block_tag_refs_cache_split_impl(write_pool, read_pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt block_tag_refs cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for block_tag_refs cache");
            Err(e)
        }
    }
}

async fn rebuild_block_tag_refs_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Read phase — from read_pool.
    let tag_ids: HashSet<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(read_pool)
    .await?
    .into_iter()
    .collect();

    let source_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
    )
    .fetch_all(read_pool)
    .await?;

    let re = super::tag_ref_re();
    let mut rows: HashSet<(String, String)> = HashSet::new();
    for row in &source_rows {
        let content = row.content.as_deref().unwrap_or("");
        for cap in re.captures_iter(content) {
            let tag_id = cap[1].to_string();
            if tag_ids.contains(&tag_id) {
                rows.insert((row.id.clone(), tag_id));
            }
        }
    }

    // Write phase — DELETE + chunked INSERT on write_pool.
    let mut tx = write_pool.begin().await?;
    sqlx::query!("DELETE FROM block_tag_refs")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    let rows_vec: Vec<(String, String)> = rows.into_iter().collect();
    for chunk in rows_vec.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }
    tx.commit().await?;
    Ok(inserted)
}
