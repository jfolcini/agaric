use sqlx::SqlitePool;
use std::collections::HashSet;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// reindex_block_links (p1-t21)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_links` for a single block.
///
/// 1. Opens a transaction for a consistent read snapshot.
/// 2. Reads the block's current `content` and its existing outbound links.
/// 3. Parses all `[[ULID]]` and `((ULID))` tokens via regex.
/// 4. Diffs: deletes removed links, inserts added links within the same tx.
pub async fn reindex_block_links(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // 1. Get current content (combined with step 2 in the same tx to avoid
    //    an extra connection round-trip).
    //
    // Filter `is_conflict = 0` so conflict-copy source blocks do not contribute
    // outbound links to `block_links` — mirrors `cache/block_tag_refs.rs` and
    // prevents conflict copies from leaking into `list_backlinks` (M-14).
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
        block_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens
    let new_targets: HashSet<String> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links (same tx — consistent snapshot)
    let existing_rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ?",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.target_id).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — transaction is rolled back on drop (no commit needed).
        return Ok(());
    }

    // L-24: batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT OR IGNORE skips PK/UNIQUE conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_links (source_id, target_id) \
             SELECT ?, value FROM json_each(?) \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = value)",
        )
        .bind(block_id)
        .bind(&insert_json)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`reindex_block_links`].
///
/// Reads block content and existing links from `read_pool`, computes a diff,
/// and applies inserts/deletes on `write_pool`.
/// Used by the materializer when a separate read pool is available.
pub async fn reindex_block_links_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    // Read phase from read_pool

    // 1. Get current content
    //
    // Filter `is_conflict = 0` so conflict-copy source blocks do not contribute
    // outbound links to `block_links` — mirrors the single-pool variant above
    // and prevents conflict copies from leaking into `list_backlinks` (M-14).
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
        block_id,
    )
    .fetch_optional(read_pool)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens
    let new_targets: HashSet<String> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links from read pool
    let existing_rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ?",
        block_id,
    )
    .fetch_all(read_pool)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.target_id).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — nothing to write.
        return Ok(());
    }

    // Write phase on write pool
    let mut tx = write_pool.begin().await?;

    // L-24: batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT OR IGNORE skips PK/UNIQUE conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_links (source_id, target_id) \
             SELECT ?, value FROM json_each(?) \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = value)",
        )
        .bind(block_id)
        .bind(&insert_json)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}
