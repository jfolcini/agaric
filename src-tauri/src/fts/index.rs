//! FTS index management — create, update, remove, and rebuild FTS entries.

use sqlx::{Row, SqlitePool};

use super::strip::{load_ref_maps, strip_for_fts, strip_for_fts_with_maps};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// FTS index management
// ---------------------------------------------------------------------------

/// Update FTS index for a single block.
///
/// Reads the block from the blocks table, strips content, and upserts
/// the FTS entry. If the block is deleted, a conflict, or has no content,
/// removes it from the index instead.
pub async fn update_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        r#"SELECT id, content, deleted_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    match row {
        None => {
            // Block doesn't exist — remove from FTS if present
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.deleted_at.is_some() => {
            // deleted_at IS NOT NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.is_conflict => {
            // is_conflict = 1 — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.content.is_none() => {
            // content IS NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(r) => {
            // Active block with content — strip and index
            let content = r.content.unwrap();
            let stripped = strip_for_fts(&content, pool).await?;

            // Delete existing entry
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;

            // Insert new entry
            sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                .bind(block_id)
                .bind(&stripped)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Split-pool variant: reads from `read_pool`, writes to `write_pool`.
/// Reduces write-lock hold time for background materializer tasks.
///
/// The read-write gap is acceptable because FTS indexing is eventually
/// consistent — if a block changes between read and write phases, the
/// next materializer task will correct the stale entry.
pub async fn update_fts_for_block_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    // Phase 1: Read — no write lock needed
    let row = sqlx::query!(
        r#"SELECT id, content, deleted_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(read_pool)
    .await?;

    // Determine what to write
    let should_delete = match &row {
        None => true,
        Some(r) if r.deleted_at.is_some() => true,
        Some(r) if r.is_conflict => true,
        Some(r) if r.content.is_none() => true,
        _ => false,
    };

    if should_delete {
        // Phase 2a: Delete only — minimal write lock
        sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
            .bind(block_id)
            .execute(write_pool)
            .await?;
        return Ok(());
    }

    // Phase 1b: Strip content using read pool
    let content = row.unwrap().content.unwrap();
    let stripped = strip_for_fts(&content, read_pool).await?;

    // Phase 2b: Write — minimal transaction
    let mut tx = write_pool.begin().await?;
    sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
        .bind(block_id)
        .bind(&stripped)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Remove a block from the FTS index (for soft-delete/purge).
pub async fn remove_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reindex FTS for all blocks that reference the given tag or page block.
///
/// When a tag/page is renamed (edited), the FTS entries for every block that
/// references it become stale because `strip_for_fts` resolves `#[ULID]` /
/// `[[ULID]]` tokens to human-readable names. This function finds all
/// referencing blocks and re-runs FTS indexing for each.
///
/// ## Performance
///
/// Pre-loads tag/page name maps once (2 queries), then uses `json_each()` to
/// batch the SELECT and DELETE into single queries. Only the INSERT remains
/// per-row (because `strip_for_fts_with_maps` processes each block
/// differently). This reduces from N×3 queries to N+2 (1 batch SELECT +
/// 1 batch DELETE + N INSERTs) inside a single transaction.
pub async fn reindex_fts_references(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    // Find blocks referencing this ID via block_tags (for tags)
    let tag_refs: Vec<String> =
        sqlx::query_scalar!("SELECT block_id FROM block_tags WHERE tag_id = ?", block_id)
            .fetch_all(pool)
            .await?;

    // Find blocks referencing this ID via block_links (for pages)
    let link_refs: Vec<String> = sqlx::query_scalar!(
        "SELECT source_id FROM block_links WHERE target_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    // Collect unique block IDs
    let mut seen = std::collections::HashSet::new();
    let unique_ids: Vec<String> = tag_refs
        .into_iter()
        .chain(link_refs.into_iter())
        .filter(|bid| seen.insert(bid.clone()))
        .collect();

    if unique_ids.is_empty() {
        return Ok(());
    }

    // Pre-load tag/page name maps (2 queries instead of 2*N)
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    let ids_json = serde_json::to_string(&unique_ids)?;

    // Single transaction for all updates
    let mut tx = pool.begin().await?;

    // Batch fetch all block metadata (1 query instead of N)
    let rows = sqlx::query(
        r#"SELECT id, content, deleted_at, is_conflict FROM blocks
           WHERE id IN (SELECT value FROM json_each(?))"#,
    )
    .bind(&ids_json)
    .fetch_all(&mut *tx)
    .await?;

    // Batch delete all old FTS entries (1 query instead of N)
    sqlx::query("DELETE FROM fts_blocks WHERE block_id IN (SELECT value FROM json_each(?))")
        .bind(&ids_json)
        .execute(&mut *tx)
        .await?;

    // Per-row INSERT (strip_for_fts_with_maps is sync, can't batch)
    for row in &rows {
        let id: &str = row.get("id");
        let deleted_at: Option<&str> = row.get("deleted_at");
        let is_conflict: bool = row.get("is_conflict");
        let content: Option<&str> = row.get("content");

        if deleted_at.is_none() && !is_conflict {
            if let Some(content) = content {
                let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
                sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                    .bind(id)
                    .bind(&stripped)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Full rebuild: clear fts_blocks, re-index all non-deleted, non-conflict blocks with content.
///
/// Batches tag/page lookups by loading all names/titles into HashMaps first.
///
/// ## Performance
///
/// This is an O(n) operation over all active blocks — it loads every block's
/// content into memory, strips it, and re-inserts into the FTS table inside a
/// single transaction.  This is **expected and intentional**: the function is
/// only called at application boot and on explicit user request (e.g. "rebuild
/// search index"), never incrementally.  Single-block updates go through
/// [`update_fts_for_block`] instead.
pub async fn rebuild_fts_index(pool: &SqlitePool) -> Result<(), AppError> {
    // Pre-load tag/page name maps (shared helper)
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    // Start transaction
    let mut tx = pool.begin().await?;

    // Clear all FTS entries
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;

    // Select all active blocks with content
    let blocks = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
    )
    .fetch_all(&mut *tx)
    .await?;

    // Strip and insert each block
    for row in &blocks {
        let content = row.content.as_deref().unwrap_or("");
        let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
        sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
            .bind(&row.id)
            .bind(&stripped)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`rebuild_fts_index`].
///
/// Reads block content and reference maps from `read_pool`, writes the
/// FTS index to `write_pool`. Used by the materializer when a separate
/// read pool is available.
pub async fn rebuild_fts_index_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    // Read phase: load ref maps and block content from read_pool
    let (tag_names, page_titles) = load_ref_maps(read_pool).await?;
    let blocks = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
    )
    .fetch_all(read_pool)
    .await?;

    // Write phase: DELETE + INSERT on write_pool
    let mut tx = write_pool.begin().await?;
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;
    for row in &blocks {
        let content = row.content.as_deref().unwrap_or("");
        let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
        sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
            .bind(&row.id)
            .bind(&stripped)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// FTS5 optimize
// ---------------------------------------------------------------------------

/// Run FTS5 optimize to merge segments.
pub async fn fts_optimize(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query("INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')")
        .execute(pool)
        .await?;
    Ok(())
}
