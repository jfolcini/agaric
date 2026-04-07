//! Cache materializer functions.
//!
//! Full-recompute rebuilds for the two read-path caches (`tags_cache`,
//! `pages_cache`), an incremental diff-based rebuild for `agenda_cache`,
//! and incremental diff-based reindexing of `block_links`.
//!
//! `rebuild_agenda_cache` computes the desired state, reads the current DB
//! state, then inserts only missing rows and deletes only stale rows —
//! reducing write amplification for large datasets.
//!
//! `rebuild_tags_cache` and `rebuild_pages_cache` still use a full
//! DELETE + INSERT cycle wrapped in a transaction for atomicity.
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Regex for [[ULID]] and ((ULID)) tokens
// ---------------------------------------------------------------------------
//
// ULIDs are encoded in Crockford base-32: exactly 26 uppercase alphanumeric
// characters (digits 0-9 and letters A-Z).  The regex captures the inner
// ULID from wiki-style `[[ULID]]` link tokens and block-reference
// `((ULID))` tokens.
//
// The regex intentionally allows mixed delimiters (e.g. `[[ULID))`) but
// that is harmless — the ULID validation is what matters, not delimiter
// matching.  In practice the serializer always produces matching pairs.
//
// Lowercase characters are intentionally excluded — ULIDs are always
// uppercase in canonical form.

static ULID_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))").expect("invalid ULID link regex")
});

/// Returns a reference to the lazily-compiled ULID-link regex.
#[inline]
fn ulid_link_re() -> &'static Regex {
    &ULID_LINK_RE
}

// ---------------------------------------------------------------------------
// rebuild_tags_cache (p1-t18)
// ---------------------------------------------------------------------------

/// Full recompute of `tags_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` (type = `tag`)
/// left-joined with `block_tags` usage counts. Tags with zero usage are
/// included.
pub async fn rebuild_tags_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;

    sqlx::query!(
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
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_pages_cache (p1-t19)
// ---------------------------------------------------------------------------

/// Full recompute of `pages_cache`.
///
/// Deletes all existing rows and re-populates from `blocks` where
/// `block_type = 'page'` and not soft-deleted.
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query!("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;

    sqlx::query!(
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
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_agenda_cache (p1-t20)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `agenda_cache`.
///
/// Instead of a full DELETE + INSERT, this function:
/// 1. Computes the desired state from the same 4 UNION ALL sources.
/// 2. Reads the current DB state.
/// 3. Diffs by PK `(date, block_id)`: inserts missing, deletes stale, updates
///    rows whose `source` value changed.
///
/// Two data sources:
/// 1. `block_properties` rows with a non-null `value_date` -> source = `property:<key>`
/// 2. `block_tags` referencing tag blocks whose name matches `date/YYYY-MM-DD`
///    (exactly 15 chars) -> source = `tag:<tag_id>`
/// 3. `blocks.due_date` column -> source = `column:due_date`
/// 4. `blocks.scheduled_date` column -> source = `column:scheduled_date`
pub async fn rebuild_agenda_cache(pool: &SqlitePool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // Step 1: Compute desired state from the same 4 UNION ALL sources.
    // Properties appear first so they win on PK deduplication (first-wins,
    // replicating INSERT OR IGNORE semantics).
    let desired_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM (
            SELECT bp.value_date AS date, bp.block_id, 'property:' || bp.key AS source
            FROM block_properties bp
            JOIN blocks b ON b.id = bp.block_id
            WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT SUBSTR(t.content, 6) AS date, bt.block_id, 'tag:' || bt.tag_id AS source
            FROM block_tags bt
            JOIN blocks t ON t.id = bt.tag_id
            JOIN blocks b ON b.id = bt.block_id
            WHERE t.block_type = 'tag'
              AND t.content LIKE 'date/%'
              AND LENGTH(t.content) = 15
              AND SUBSTR(t.content, 6, 4) GLOB '[0-9][0-9][0-9][0-9]'
              AND SUBSTR(t.content, 10, 1) = '-'
              AND SUBSTR(t.content, 11, 2) GLOB '[0-9][0-9]'
              AND SUBSTR(t.content, 13, 1) = '-'
              AND SUBSTR(t.content, 14, 2) GLOB '[0-9][0-9]'
              AND b.deleted_at IS NULL
              AND t.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT b.due_date AS date, b.id AS block_id, 'column:due_date' AS source
            FROM blocks b
            WHERE b.due_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT b.scheduled_date AS date, b.id AS block_id, 'column:scheduled_date' AS source
            FROM blocks b
            WHERE b.scheduled_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
        )",
    )
    .fetch_all(&mut *tx)
    .await?;

    // Deduplicate by PK (date, block_id), keeping first occurrence.
    let mut desired: HashMap<(&str, &str), &str> = HashMap::with_capacity(desired_rows.len());
    for (date, block_id, source) in &desired_rows {
        desired
            .entry((date.as_str(), block_id.as_str()))
            .or_insert(source.as_str());
    }

    // Step 2: Read current cache state.
    let current_rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&mut *tx)
            .await?;

    let current: HashMap<(&str, &str), &str> = current_rows
        .iter()
        .map(|(d, b, s)| ((d.as_str(), b.as_str()), s.as_str()))
        .collect();

    // Step 3: Compute diff.
    let to_delete: Vec<(&str, &str)> = current
        .keys()
        .filter(|k| !desired.contains_key(k))
        .copied()
        .collect();

    let to_insert: Vec<((&str, &str), &str)> = desired
        .iter()
        .filter(|(k, _)| !current.contains_key(k))
        .map(|(&k, &v)| (k, v))
        .collect();

    let to_update: Vec<((&str, &str), &str)> = desired
        .iter()
        .filter(|(k, v)| current.get(k).is_some_and(|cv| cv != *v))
        .map(|(&k, &v)| (k, v))
        .collect();

    if to_delete.is_empty() && to_insert.is_empty() && to_update.is_empty() {
        // No changes — transaction is rolled back on drop.
        return Ok(());
    }

    // Step 4: Apply diff.
    for (date, block_id) in &to_delete {
        sqlx::query("DELETE FROM agenda_cache WHERE date = ?1 AND block_id = ?2")
            .bind(date)
            .bind(block_id)
            .execute(&mut *tx)
            .await?;
    }

    for ((date, block_id), source) in &to_update {
        sqlx::query("UPDATE agenda_cache SET source = ?1 WHERE date = ?2 AND block_id = ?3")
            .bind(source)
            .bind(date)
            .bind(block_id)
            .execute(&mut *tx)
            .await?;
    }

    for ((date, block_id), source) in &to_insert {
        sqlx::query(
            "INSERT OR IGNORE INTO agenda_cache (date, block_id, source) VALUES (?1, ?2, ?3)",
        )
        .bind(date)
        .bind(block_id)
        .bind(source)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

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
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
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
    let new_targets: HashSet<String> = ulid_link_re()
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

    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_links WHERE source_id = ? AND target_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }

    for target in &to_insert {
        // Use INSERT ... SELECT ... WHERE EXISTS to skip targets that don't
        // exist in the blocks table. INSERT OR IGNORE does NOT suppress FK
        // violations in SQLite — only PK/UNIQUE/NOT NULL/CHECK conflicts.
        let t = *target;
        sqlx::query!(
            "INSERT OR IGNORE INTO block_links (source_id, target_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
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
// rebuild_all_caches — convenience wrapper
// ---------------------------------------------------------------------------

/// Rebuilds all three read-path caches in sequence.
///
/// Calls [`rebuild_tags_cache`], [`rebuild_pages_cache`], and
/// [`rebuild_agenda_cache`].  Each runs in its own transaction so a failure
/// in a later cache does not roll back earlier ones.
///
/// Note: `reindex_block_links` is *not* included because it operates on a
/// single block and is called per-block during materialisation.
pub async fn rebuild_all_caches(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_tags_cache(pool).await?;
    rebuild_pages_cache(pool).await?;
    rebuild_agenda_cache(pool).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Read/write split variants (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_tags_cache`].
///
/// Reads tag data from `read_pool`, writes to `write_pool`.
/// Used by the materializer when a separate read pool is available.
pub async fn rebuild_tags_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    let now = crate::now_rfc3339();

    // Read phase: fetch tag data from read pool
    let rows = sqlx::query_as::<_, (String, Option<String>, i64)>(
        "SELECT b.id, b.content, COALESCE(t.cnt, 0) \
         FROM blocks b \
         LEFT JOIN ( \
             SELECT bt.tag_id, COUNT(*) AS cnt \
             FROM block_tags bt \
             JOIN blocks blk ON blk.id = bt.block_id \
             WHERE blk.deleted_at IS NULL \
             GROUP BY bt.tag_id \
         ) t ON t.tag_id = b.id \
         WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL \
           AND b.is_conflict = 0 \
         ORDER BY b.id",
    )
    .fetch_all(read_pool)
    .await?;

    // Write phase: DELETE + INSERT on write pool
    let mut tx = write_pool.begin().await?;
    sqlx::query("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;
    for (tag_id, name, usage_count) in &rows {
        sqlx::query(
            "INSERT OR IGNORE INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(tag_id)
        .bind(name.as_deref().unwrap_or(""))
        .bind(usage_count)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`rebuild_pages_cache`].
///
/// Reads page data from `read_pool`, writes to `write_pool`.
/// Used by the materializer when a separate read pool is available.
pub async fn rebuild_pages_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    let now = crate::now_rfc3339();

    // Read phase
    let rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL \
           AND is_conflict = 0",
    )
    .fetch_all(read_pool)
    .await?;

    // Write phase
    let mut tx = write_pool.begin().await?;
    sqlx::query("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;
    for (page_id, title) in &rows {
        sqlx::query("INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, ?)")
            .bind(page_id)
            .bind(title.as_deref().unwrap_or(""))
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`rebuild_agenda_cache`].
///
/// Reads desired and current agenda state from `read_pool`, computes a diff,
/// and applies inserts/deletes/updates on `write_pool`.
/// Used by the materializer when a separate read pool is available.
pub async fn rebuild_agenda_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    // Read phase: snapshot-isolated transaction on the read pool so both
    // queries (desired state + current cache) see a consistent view.
    let mut read_tx = read_pool.begin().await?;

    // Step 1: Compute desired state from the same 4 UNION ALL sources.
    let desired_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT date, block_id, source FROM (
            SELECT bp.value_date AS date, bp.block_id, 'property:' || bp.key AS source
            FROM block_properties bp
            JOIN blocks b ON b.id = bp.block_id
            WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT SUBSTR(t.content, 6) AS date, bt.block_id, 'tag:' || bt.tag_id AS source
            FROM block_tags bt
            JOIN blocks t ON t.id = bt.tag_id
            JOIN blocks b ON b.id = bt.block_id
            WHERE t.block_type = 'tag'
              AND t.content LIKE 'date/%'
              AND LENGTH(t.content) = 15
              AND SUBSTR(t.content, 6, 4) GLOB '[0-9][0-9][0-9][0-9]'
              AND SUBSTR(t.content, 10, 1) = '-'
              AND SUBSTR(t.content, 11, 2) GLOB '[0-9][0-9]'
              AND SUBSTR(t.content, 13, 1) = '-'
              AND SUBSTR(t.content, 14, 2) GLOB '[0-9][0-9]'
              AND b.deleted_at IS NULL
              AND t.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT b.due_date AS date, b.id AS block_id, 'column:due_date' AS source
            FROM blocks b
            WHERE b.due_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
            UNION ALL
            SELECT b.scheduled_date AS date, b.id AS block_id, 'column:scheduled_date' AS source
            FROM blocks b
            WHERE b.scheduled_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
        )",
    )
    .fetch_all(&mut *read_tx)
    .await?;

    // Deduplicate by PK (date, block_id), keeping first occurrence.
    let mut desired: HashMap<(&str, &str), &str> = HashMap::with_capacity(desired_rows.len());
    for (date, block_id, source) in &desired_rows {
        desired
            .entry((date.as_str(), block_id.as_str()))
            .or_insert(source.as_str());
    }

    // Step 2: Read current cache state (same snapshot).
    let current_rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&mut *read_tx)
            .await?;

    // Release the read snapshot before computing diff + writing.
    drop(read_tx);

    let current: HashMap<(&str, &str), &str> = current_rows
        .iter()
        .map(|(d, b, s)| ((d.as_str(), b.as_str()), s.as_str()))
        .collect();

    // Step 3: Compute diff.
    let to_delete: Vec<(&str, &str)> = current
        .keys()
        .filter(|k| !desired.contains_key(k))
        .copied()
        .collect();

    let to_insert: Vec<((&str, &str), &str)> = desired
        .iter()
        .filter(|(k, _)| !current.contains_key(k))
        .map(|(&k, &v)| (k, v))
        .collect();

    let to_update: Vec<((&str, &str), &str)> = desired
        .iter()
        .filter(|(k, v)| current.get(k).is_some_and(|cv| cv != *v))
        .map(|(&k, &v)| (k, v))
        .collect();

    if to_delete.is_empty() && to_insert.is_empty() && to_update.is_empty() {
        // No changes — nothing to write.
        return Ok(());
    }

    // Step 4: Apply diff on write pool.
    let mut tx = write_pool.begin().await?;

    for (date, block_id) in &to_delete {
        sqlx::query("DELETE FROM agenda_cache WHERE date = ?1 AND block_id = ?2")
            .bind(date)
            .bind(block_id)
            .execute(&mut *tx)
            .await?;
    }

    for ((date, block_id), source) in &to_update {
        sqlx::query("UPDATE agenda_cache SET source = ?1 WHERE date = ?2 AND block_id = ?3")
            .bind(source)
            .bind(date)
            .bind(block_id)
            .execute(&mut *tx)
            .await?;
    }

    for ((date, block_id), source) in &to_insert {
        sqlx::query(
            "INSERT OR IGNORE INTO agenda_cache (date, block_id, source) VALUES (?1, ?2, ?3)",
        )
        .bind(date)
        .bind(block_id)
        .bind(source)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

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
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
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
    let new_targets: HashSet<String> = ulid_link_re()
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

    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_links WHERE source_id = ? AND target_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }

    for target in &to_insert {
        let t = *target;
        sqlx::query!(
            "INSERT OR IGNORE INTO block_links (source_id, target_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for cache materializer functions — tags, pages, agenda, and block
    //! links.  Covers basic rebuilds, exclusion filters (deleted, conflict, NULL
    //! content), idempotency, boundary conditions on date-tag length, and the
    //! incremental diff logic in `reindex_block_links`.

    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Deterministic test fixtures ─────────────────────────────────────

    const FIXED_DELETED_AT: &str = "2025-01-15T12:00:00+00:00";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block with the given type and content.
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            id,
            block_type,
            content,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a block with NULL content (content column omitted).
    async fn insert_block_null_content(pool: &SqlitePool, id: &str, block_type: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type) VALUES (?, ?)",
            id,
            block_type,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Soft-delete a block using a fixed, deterministic timestamp.
    async fn soft_delete_block(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            FIXED_DELETED_AT,
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Mark a block as a conflict (is_conflict = 1).
    async fn mark_conflict(pool: &SqlitePool, id: &str) {
        sqlx::query!("UPDATE blocks SET is_conflict = 1 WHERE id = ?", id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Associate a block with a tag via `block_tags`.
    async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            block_id,
            tag_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Set a date property on a block.
    async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: Option<&str>) {
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            block_id,
            key,
            value_date,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Count rows in a table (test-only convenience).
    async fn count_rows(pool: &SqlitePool, table: &str) -> i64 {
        let query = format!("SELECT COUNT(*) FROM {table}");
        let (count,): (i64,) = sqlx::query_as(&query).fetch_one(pool).await.unwrap();
        count
    }

    // ====================================================================
    // tags_cache
    // ====================================================================

    #[tokio::test]
    async fn tags_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "urgent").await;
        insert_block(&pool, "TAG02", "tag", "low-priority").await;
        insert_block(&pool, "BLK01", "content", "some note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let rows = sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 2, "both tags must appear in cache");
        assert_eq!(
            (&rows[0].tag_id, rows[0].name.as_str(), rows[0].usage_count),
            (&"TAG02".to_string(), "low-priority", 0),
            "unused tag must have count 0"
        );
        assert_eq!(
            (&rows[1].tag_id, rows[1].name.as_str(), rows[1].usage_count),
            (&"TAG01".to_string(), "urgent", 1),
            "tagged-once tag must have count 1"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_deleted_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "active").await;
        insert_block(&pool, "TAG02", "tag", "deleted-tag").await;
        soft_delete_block(&pool, "TAG02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "soft-deleted tag must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_conflict_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "normal").await;
        insert_block(&pool, "TAG02", "tag", "conflict").await;
        mark_conflict(&pool, "TAG02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "conflict tag (is_conflict = 1) must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_excludes_null_content_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "has-content").await;
        insert_block_null_content(&pool, "TAG02", "tag").await;

        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "NULL-content tag must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_includes_zero_usage_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "unused-tag").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let rows = sqlx::query!("SELECT tag_id, usage_count FROM tags_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            (&rows[0].tag_id, rows[0].usage_count),
            (&"TAG01".to_string(), 0),
            "unused tag must appear with count 0"
        );
    }

    #[tokio::test]
    async fn tags_cache_full_recompute_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "first").await;
        rebuild_tags_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "tags_cache").await, 1);

        soft_delete_block(&pool, "TAG01").await;
        rebuild_tags_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn tags_cache_aggregates_high_usage_count() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "HTAG", "tag", "popular").await;

        for i in 0..5 {
            let blk = format!("HB{i:04}");
            insert_block(&pool, &blk, "content", &format!("note {i}")).await;
            add_tag(&pool, &blk, "HTAG").await;
        }

        rebuild_tags_cache(&pool).await.unwrap();

        let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'HTAG'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.usage_count, 5,
            "usage count must aggregate all tagged blocks"
        );
    }

    #[tokio::test]
    async fn tags_cache_rebuild_is_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "alpha").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache(&pool).await.unwrap();
        let first: Vec<_> =
            sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        rebuild_tags_cache(&pool).await.unwrap();
        let second: Vec<_> =
            sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(
            first.len(),
            second.len(),
            "consecutive rebuilds must produce identical results"
        );
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a.tag_id, b.tag_id);
            assert_eq!(a.name, b.name);
            assert_eq!(a.usage_count, b.usage_count);
        }
    }

    // ====================================================================
    // pages_cache
    // ====================================================================

    #[tokio::test]
    async fn pages_cache_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "My First Page").await;
        insert_block(&pool, "PAGE02", "page", "My Second Page").await;
        insert_block(&pool, "BLK01", "content", "just content").await;

        rebuild_pages_cache(&pool).await.unwrap();

        let rows = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY title")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 2, "only page-type blocks must appear");
        assert_eq!(
            (rows[0].page_id.as_str(), rows[0].title.as_str()),
            ("PAGE01", "My First Page"),
        );
        assert_eq!(
            (rows[1].page_id.as_str(), rows[1].title.as_str()),
            ("PAGE02", "My Second Page"),
        );
    }

    #[tokio::test]
    async fn pages_cache_excludes_deleted_pages() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Active Page").await;
        insert_block(&pool, "PAGE02", "page", "Deleted Page").await;
        soft_delete_block(&pool, "PAGE02").await;

        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "soft-deleted page must be excluded"
        );
    }

    #[tokio::test]
    async fn pages_cache_full_recompute_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Will be deleted").await;
        rebuild_pages_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "pages_cache").await, 1);

        soft_delete_block(&pool, "PAGE01").await;
        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn pages_cache_excludes_null_content() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Real Page").await;
        insert_block_null_content(&pool, "PAGE02", "page").await;

        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "NULL-content page must be excluded"
        );
    }

    #[tokio::test]
    async fn pages_cache_rebuild_is_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Stable Page").await;

        rebuild_pages_cache(&pool).await.unwrap();
        let first: Vec<_> = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY page_id")
            .fetch_all(&pool)
            .await
            .unwrap();

        rebuild_pages_cache(&pool).await.unwrap();
        let second: Vec<_> =
            sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY page_id")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(
            first.len(),
            second.len(),
            "consecutive rebuilds must produce identical results"
        );
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a.page_id, b.page_id);
            assert_eq!(a.title, b.title);
        }
    }

    // ====================================================================
    // agenda_cache
    // ====================================================================

    #[tokio::test]
    async fn agenda_cache_populates_from_date_properties() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task with due date").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].date.as_str(),
            "2025-01-15",
            "date must match property value"
        );
        assert_eq!(rows[0].block_id, "BLK01");
        assert_eq!(
            rows[0].source.as_str(),
            "property:due",
            "source must be property:<key>"
        );
    }

    #[tokio::test]
    async fn agenda_cache_populates_from_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting notes").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].date.as_str(),
            "2025-03-20",
            "date must be extracted from tag content"
        );
        assert_eq!(rows[0].block_id, "BLK01");
        assert_eq!(
            rows[0].source.as_str(),
            "tag:DTAG1",
            "source must be tag:<tag_id>"
        );
    }

    #[tokio::test]
    async fn agenda_cache_combines_property_and_tag_sources() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task").await;
        set_property(&pool, "BLK01", "deadline", Some("2025-06-01")).await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-06-01").await;
        insert_block(&pool, "BLK02", "content", "event").await;
        add_tag(&pool, "BLK02", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            2,
            "both property and tag sources must be included"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "deleted task").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;
        soft_delete_block(&pool, "BLK01").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "soft-deleted block must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_deleted_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting").await;
        add_tag(&pool, "BLK01", "DTAG1").await;
        soft_delete_block(&pool, "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "deleted date-tag must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_ignores_non_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "date/short").await;
        insert_block(&pool, "TAG02", "tag", "notdate/2025-01-01").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;
        add_tag(&pool, "BLK01", "TAG02").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "tags not matching date/YYYY-MM-DD (15 chars) must be ignored"
        );
    }

    #[tokio::test]
    async fn agenda_cache_deduplicates_same_date_block_pair() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "busy day").await;
        set_property(&pool, "BLK01", "due", Some("2025-06-01")).await;
        set_property(&pool, "BLK01", "scheduled", Some("2025-06-01")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "PK (date, block_id) must deduplicate via OR IGNORE"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_exactly_15_chars() {
        let (pool, _dir) = test_pool().await;

        let exact = "date/2025-03-20"; // 15 chars
        assert_eq!(exact.len(), 15);

        insert_block(&pool, "DTAG1", "tag", exact).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "exactly 15-char date tag must match"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_14_chars_excluded() {
        let (pool, _dir) = test_pool().await;

        let short = "date/2025-3-20"; // 14 chars
        assert_eq!(short.len(), 14);

        insert_block(&pool, "DTAG1", "tag", short).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "14-char date tag must NOT match"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_boundary_16_chars_excluded() {
        let (pool, _dir) = test_pool().await;

        let long = "date/2025-03-20X"; // 16 chars
        assert_eq!(long.len(), 16);

        insert_block(&pool, "DTAG1", "tag", long).await;
        insert_block(&pool, "BLK01", "content", "event").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "16-char date tag must NOT match"
        );
    }

    #[tokio::test]
    async fn agenda_cache_non_date_15_char_string_excluded() {
        let (pool, _dir) = test_pool().await;

        // 15 chars but not a valid date pattern — e.g. "date/ABCDEFGHIJ"
        let fake = "date/ABCDEFGHIJ";
        assert_eq!(fake.len(), 15);

        insert_block(&pool, "DTAG1", "tag", fake).await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "15-char non-date string must be excluded by GLOB validation"
        );
    }

    #[tokio::test]
    async fn agenda_cache_date_tag_with_bad_separator_excluded() {
        let (pool, _dir) = test_pool().await;

        // 15 chars, starts with date/, but uses dots instead of dashes
        let bad_sep = "date/2025.03.20";
        assert_eq!(bad_sep.len(), 15);

        insert_block(&pool, "DTAG1", "tag", bad_sep).await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "date tag with bad separators must be excluded"
        );
    }

    // ====================================================================
    // agenda_cache — incremental rebuild behaviour
    // ====================================================================

    #[tokio::test]
    async fn rebuild_agenda_incremental_inserts_new_entries() {
        let (pool, _dir) = test_pool().await;

        // Establish baseline with one entry.
        insert_block(&pool, "BLK01", "content", "first task").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

        // Add a second block with a due_date.
        insert_block(&pool, "BLK02", "content", "second task").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-09-15' WHERE id = 'BLK02'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            2,
            "incremental rebuild must insert the new entry"
        );

        // Verify both entries are present.
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT date, block_id FROM agenda_cache ORDER BY date")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows[0], ("2025-08-01".to_string(), "BLK01".to_string()));
        assert_eq!(rows[1], ("2025-09-15".to_string(), "BLK02".to_string()));
    }

    #[tokio::test]
    async fn rebuild_agenda_incremental_removes_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "will be deleted").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache(&pool).await.unwrap();
        assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

        // Soft-delete the block — its cache entry becomes stale.
        soft_delete_block(&pool, "BLK01").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "incremental rebuild must delete the stale entry"
        );
    }

    #[tokio::test]
    async fn rebuild_agenda_incremental_preserves_unchanged() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "stable task").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache(&pool).await.unwrap();

        // Record the rowid of the cached entry. A DELETE + re-INSERT would
        // allocate a new rowid; the incremental approach must keep it.
        let (original_rowid,): (i64,) = sqlx::query_as(
            "SELECT rowid FROM agenda_cache WHERE date = '2025-08-01' AND block_id = 'BLK01'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // Rebuild again with no changes to source data.
        rebuild_agenda_cache(&pool).await.unwrap();

        let (rowid_after,): (i64,) = sqlx::query_as(
            "SELECT rowid FROM agenda_cache WHERE date = '2025-08-01' AND block_id = 'BLK01'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            original_rowid, rowid_after,
            "unchanged entry must preserve its rowid (not deleted + re-inserted)"
        );
        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "entry count must remain the same"
        );
    }

    // ====================================================================
    // block_links
    // ====================================================================

    #[tokio::test]
    async fn block_links_basic_reindex() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "See [[01HZ00000000000000000000AB]] and [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "both link targets must be indexed");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_incremental_diff_adds_and_removes() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(&pool, "01HZ00000000000000000000EF", "content", "target C").await;

        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();
        assert_eq!(count_rows(&pool, "block_links").await, 2, "initial: A + B");

        // Update content: remove B, add C
        sqlx::query!(
            "UPDATE blocks SET content = ? WHERE id = ?",
            "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000EF]]",
            "01HZ0000000000000000000SRC",
        )
        .execute(&pool)
        .await
        .unwrap();

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000EF");
    }

    #[tokio::test]
    async fn block_links_deleted_source_clears_all_links() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();
        assert_eq!(count_rows(&pool, "block_links").await, 1);

        soft_delete_block(&pool, "01HZ0000000000000000000SRC").await;
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "all links must be removed when source is soft-deleted"
        );
    }

    #[tokio::test]
    async fn block_links_no_links_in_content() {
        let (pool, _dir) = test_pool().await;

        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "plain text with no links",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "no links must be created for plain text"
        );
    }

    #[tokio::test]
    async fn block_links_nonexistent_source_is_noop() {
        let (pool, _dir) = test_pool().await;

        reindex_block_links(&pool, "NONEXISTENT0000000000000000")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "reindexing nonexistent block must not create links"
        );
    }

    #[tokio::test]
    async fn block_links_deduplicates_repeated_references() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]] and again [[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "duplicate references must be deduplicated by HashSet"
        );
    }

    #[tokio::test]
    async fn block_links_noop_when_content_unchanged() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        // Second call with same content — no-op (early return)
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "idempotent reindex must not duplicate links"
        );
    }

    #[tokio::test]
    async fn block_links_ignores_lowercase_ulids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01hz00000000000000000000ab]]", // lowercase — must not match
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "lowercase ULIDs must not be matched by the regex"
        );
    }

    #[tokio::test]
    async fn block_links_ignores_malformed_ulid_lengths() {
        let (pool, _dir) = test_pool().await;

        // 10-char (too short) and 28-char (too long) must not match
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "short: [[ABCDEFGHIJ]] long: [[01HZ00000000000000000000ABCD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "malformed ULIDs (wrong length) must not be matched"
        );
    }

    #[tokio::test]
    async fn block_links_parses_adjacent_links() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "B").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]][[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "adjacent links must both be parsed");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_extracts_links_inside_code_fences() {
        let (pool, _dir) = test_pool().await;

        // The regex is context-unaware by design — links inside code fences
        // are still extracted and indexed.
        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "```\n[[01HZ00000000000000000000AB]]\n```",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            1,
            "regex is context-unaware — code fence links are extracted"
        );
    }

    // ====================================================================
    // rebuild_all_caches & empty tables
    // ====================================================================

    #[tokio::test]
    async fn rebuild_all_succeeds_on_empty_tables() {
        let (pool, _dir) = test_pool().await;

        rebuild_tags_cache(&pool).await.unwrap();
        rebuild_pages_cache(&pool).await.unwrap();
        rebuild_agenda_cache(&pool).await.unwrap();
        reindex_block_links(&pool, "DOESNOTEXIST00000000000000")
            .await
            .unwrap();

        assert_eq!(count_rows(&pool, "tags_cache").await, 0);
        assert_eq!(count_rows(&pool, "pages_cache").await, 0);
        assert_eq!(count_rows(&pool, "agenda_cache").await, 0);
        assert_eq!(count_rows(&pool, "block_links").await, 0);
    }

    #[tokio::test]
    async fn rebuild_all_caches_populates_all_three() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "work").await;
        insert_block(&pool, "PAGE01", "page", "Home").await;
        insert_block(&pool, "BLK01", "content", "task").await;
        set_property(&pool, "BLK01", "due", Some("2025-07-01")).await;

        rebuild_all_caches(&pool).await.unwrap();

        assert_eq!(count_rows(&pool, "tags_cache").await, 1, "tags populated");
        assert_eq!(count_rows(&pool, "pages_cache").await, 1, "pages populated");
        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "agenda populated"
        );
    }

    // ====================================================================
    // Audit findings: F03, F04, F05, F23
    // ====================================================================

    #[tokio::test]
    async fn tags_cache_usage_excludes_deleted_tagged_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "popular").await;
        insert_block(&pool, "BLK01", "content", "alive note").await;
        insert_block(&pool, "BLK02", "content", "deleted note").await;
        add_tag(&pool, "BLK01", "TAG01").await;
        add_tag(&pool, "BLK02", "TAG01").await;
        soft_delete_block(&pool, "BLK02").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let row = sqlx::query!("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG01'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.usage_count, 1,
            "usage_count should exclude soft-deleted tagged blocks"
        );
    }

    #[tokio::test]
    async fn tags_cache_handles_duplicate_tag_names() {
        let (pool, _dir) = test_pool().await;

        // Two tag blocks with the same content (name). INSERT OR IGNORE
        // should keep the first and skip the duplicate.
        insert_block(&pool, "TAG01", "tag", "duplicate-name").await;
        insert_block(&pool, "TAG02", "tag", "duplicate-name").await;

        rebuild_tags_cache(&pool).await.unwrap();

        let count = count_rows(&pool, "tags_cache").await;
        assert_eq!(
            count, 1,
            "INSERT OR IGNORE should handle duplicate tag names"
        );
    }

    #[tokio::test]
    async fn pages_cache_excludes_conflict_pages() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Normal Page").await;
        insert_block(&pool, "PAGE02", "page", "Conflict Page").await;
        mark_conflict(&pool, "PAGE02").await;

        rebuild_pages_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "conflict page (is_conflict = 1) must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_conflict_blocks_property_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "conflict task").await;
        mark_conflict(&pool, "BLK01").await;
        set_property(&pool, "BLK01", "due", Some("2025-06-01")).await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "conflict block must be excluded from agenda (property source)"
        );
    }

    #[tokio::test]
    async fn agenda_cache_excludes_conflict_blocks_tag_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-06-01").await;
        insert_block(&pool, "BLK01", "content", "conflict event").await;
        mark_conflict(&pool, "BLK01").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "conflict block must be excluded from agenda (tag source)"
        );
    }

    // ====================================================================
    // reindex_block_links — dangling target and NULL-content edge cases
    // ====================================================================

    /// A block whose content references a `[[ULID]]` that does NOT exist in
    /// the blocks table must not crash `reindex_block_links`. The INSERT uses
    /// `WHERE EXISTS` to skip dangling references.
    #[tokio::test]
    async fn reindex_block_links_with_dangling_target_ulid() {
        let (pool, _dir) = test_pool().await;

        // Insert a source block whose content links to a ULID that has no
        // corresponding row in the blocks table.
        let nonexistent_ulid = "01HZ00000000000000NONEXIST";
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            &format!("see [[{nonexistent_ulid}]] for details"),
        )
        .await;

        // Must not panic or return an error
        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        // No link row should be created because the target doesn't exist
        let count = count_rows(&pool, "block_links").await;
        assert_eq!(
            count, 0,
            "dangling [[ULID]] must not produce a block_links row (FK guard)"
        );
    }

    /// A block with NULL content must not crash `reindex_block_links`.
    /// The function should treat NULL content as empty (no links to extract).
    #[tokio::test]
    async fn reindex_block_links_on_null_content_block() {
        let (pool, _dir) = test_pool().await;

        // Insert a block with NULL content
        insert_block_null_content(&pool, "01HZ0000000000000NULLCONT", "content").await;

        // Must not panic or return an error
        reindex_block_links(&pool, "01HZ0000000000000NULLCONT")
            .await
            .unwrap();

        // No links should be created
        let count = count_rows(&pool, "block_links").await;
        assert_eq!(
            count, 0,
            "NULL-content block must produce zero block_links rows"
        );
    }

    // ====================================================================
    // agenda_cache — blocks.due_date column source
    // ====================================================================

    #[tokio::test]
    async fn rebuild_agenda_cache_includes_due_date_from_blocks_column() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK_DUE1", "content", "has due date").await;

        // Set blocks.due_date directly via SQL UPDATE
        sqlx::query("UPDATE blocks SET due_date = '2026-06-15' WHERE id = 'BLK_DUE1'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows = sqlx::query!(
            "SELECT date, block_id, source FROM agenda_cache WHERE block_id = 'BLK_DUE1'"
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            rows.len(),
            1,
            "agenda_cache should contain one entry for the block with due_date"
        );
        assert_eq!(rows[0].date, "2026-06-15", "date should match due_date");
        assert_eq!(rows[0].block_id, "BLK_DUE1");
        assert_eq!(
            rows[0].source, "column:due_date",
            "source should be column:due_date"
        );
    }

    #[tokio::test]
    async fn rebuild_agenda_cache_excludes_null_due_date_from_blocks_column() {
        let (pool, _dir) = test_pool().await;

        // Create a content block with NULL due_date (the default)
        insert_block(&pool, "BLK_NULL", "content", "no due date").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        // Check that no agenda entry exists from the column:due_date source
        let rows = sqlx::query!(
            "SELECT COUNT(*) as cnt FROM agenda_cache WHERE block_id = 'BLK_NULL' AND source = 'column:due_date'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            rows.cnt, 0,
            "NULL due_date should NOT produce an agenda_cache entry from column:due_date"
        );
    }

    // ====================================================================
    // reindex_block_links — ((ULID)) block references (F-4)
    // ====================================================================

    /// `((ULID))` block-reference tokens must be extracted and tracked in
    /// `block_links` just like `[[ULID]]` page-link tokens.
    #[tokio::test]
    async fn reindex_block_links_tracks_block_refs() {
        let (pool, _dir) = test_pool().await;

        insert_block(
            &pool,
            "01HZ00000000000000000000AB",
            "content",
            "target block",
        )
        .await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "refer to ((01HZ00000000000000000000AB)) here",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 1, "(( )) block ref must be tracked");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
    }

    /// Content containing both `[[ULID]]` page links and `((ULID))` block
    /// references must produce one `block_links` row per distinct target.
    #[tokio::test]
    async fn reindex_block_links_tracks_both_link_types() {
        let (pool, _dir) = test_pool().await;

        insert_block(
            &pool,
            "01HZ00000000000000000000AB",
            "content",
            "page target",
        )
        .await;
        insert_block(
            &pool,
            "01HZ00000000000000000000CD",
            "content",
            "block target",
        )
        .await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "see [[01HZ00000000000000000000AB]] and ((01HZ00000000000000000000CD))",
        )
        .await;

        reindex_block_links(&pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            rows.len(),
            2,
            "both [[ ]] and (( )) targets must be tracked"
        );
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000CD");
    }

    // ====================================================================
    // _split variants — read/write pool separation
    // ====================================================================

    #[tokio::test]
    async fn tags_cache_split_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "urgent").await;
        insert_block(&pool, "TAG02", "tag", "low-priority").await;
        insert_block(&pool, "BLK01", "content", "some note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache_split(&pool, &pool).await.unwrap();

        let rows = sqlx::query!("SELECT tag_id, name, usage_count FROM tags_cache ORDER BY name")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 2, "both tags must appear in cache");
        assert_eq!(
            (&rows[0].tag_id, rows[0].name.as_str(), rows[0].usage_count),
            (&"TAG02".to_string(), "low-priority", 0),
            "unused tag must have count 0"
        );
        assert_eq!(
            (&rows[1].tag_id, rows[1].name.as_str(), rows[1].usage_count),
            (&"TAG01".to_string(), "urgent", 1),
            "tagged-once tag must have count 1"
        );
    }

    #[tokio::test]
    async fn tags_cache_split_excludes_deleted_and_conflict() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "active").await;
        insert_block(&pool, "TAG02", "tag", "deleted-tag").await;
        insert_block(&pool, "TAG03", "tag", "conflict-tag").await;
        soft_delete_block(&pool, "TAG02").await;
        mark_conflict(&pool, "TAG03").await;

        rebuild_tags_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            1,
            "soft-deleted and conflict tags must be excluded"
        );
    }

    #[tokio::test]
    async fn tags_cache_split_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "alpha").await;
        insert_block(&pool, "BLK01", "content", "note").await;
        add_tag(&pool, "BLK01", "TAG01").await;

        rebuild_tags_cache_split(&pool, &pool).await.unwrap();
        let first = count_rows(&pool, "tags_cache").await;

        rebuild_tags_cache_split(&pool, &pool).await.unwrap();
        let second = count_rows(&pool, "tags_cache").await;

        assert_eq!(first, second, "consecutive rebuilds must be idempotent");
    }

    #[tokio::test]
    async fn tags_cache_split_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG01", "tag", "first").await;
        rebuild_tags_cache_split(&pool, &pool).await.unwrap();
        assert_eq!(count_rows(&pool, "tags_cache").await, 1);

        soft_delete_block(&pool, "TAG01").await;
        rebuild_tags_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "tags_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn pages_cache_split_basic_rebuild() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "My First Page").await;
        insert_block(&pool, "PAGE02", "page", "My Second Page").await;
        insert_block(&pool, "BLK01", "content", "just content").await;

        rebuild_pages_cache_split(&pool, &pool).await.unwrap();

        let rows = sqlx::query!("SELECT page_id, title FROM pages_cache ORDER BY title")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 2, "only page-type blocks must appear");
        assert_eq!(
            (rows[0].page_id.as_str(), rows[0].title.as_str()),
            ("PAGE01", "My First Page"),
        );
        assert_eq!(
            (rows[1].page_id.as_str(), rows[1].title.as_str()),
            ("PAGE02", "My Second Page"),
        );
    }

    #[tokio::test]
    async fn pages_cache_split_excludes_deleted_and_conflict() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Active Page").await;
        insert_block(&pool, "PAGE02", "page", "Deleted Page").await;
        insert_block(&pool, "PAGE03", "page", "Conflict Page").await;
        soft_delete_block(&pool, "PAGE02").await;
        mark_conflict(&pool, "PAGE03").await;

        rebuild_pages_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            1,
            "soft-deleted and conflict pages must be excluded"
        );
    }

    #[tokio::test]
    async fn pages_cache_split_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Stable Page").await;

        rebuild_pages_cache_split(&pool, &pool).await.unwrap();
        let first = count_rows(&pool, "pages_cache").await;

        rebuild_pages_cache_split(&pool, &pool).await.unwrap();
        let second = count_rows(&pool, "pages_cache").await;

        assert_eq!(first, second, "consecutive rebuilds must be idempotent");
    }

    #[tokio::test]
    async fn pages_cache_split_clears_stale_entries() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE01", "page", "Will be deleted").await;
        rebuild_pages_cache_split(&pool, &pool).await.unwrap();
        assert_eq!(count_rows(&pool, "pages_cache").await, 1);

        soft_delete_block(&pool, "PAGE01").await;
        rebuild_pages_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "pages_cache").await,
            0,
            "stale entry must be cleared after rebuild"
        );
    }

    #[tokio::test]
    async fn agenda_cache_split_populates_from_date_properties() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "task with due date").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;

        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

        let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date.as_str(), "2025-01-15");
        assert_eq!(rows[0].block_id, "BLK01");
        assert_eq!(rows[0].source.as_str(), "property:due");
    }

    #[tokio::test]
    async fn agenda_cache_split_populates_from_date_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DTAG1", "tag", "date/2025-03-20").await;
        insert_block(&pool, "BLK01", "content", "meeting notes").await;
        add_tag(&pool, "BLK01", "DTAG1").await;

        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

        let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date.as_str(), "2025-03-20");
        assert_eq!(rows[0].block_id, "BLK01");
        assert_eq!(rows[0].source.as_str(), "tag:DTAG1");
    }

    #[tokio::test]
    async fn agenda_cache_split_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK01", "content", "deleted task").await;
        set_property(&pool, "BLK01", "due", Some("2025-01-15")).await;
        soft_delete_block(&pool, "BLK01").await;

        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            0,
            "soft-deleted block must be excluded"
        );
    }

    #[tokio::test]
    async fn agenda_cache_split_incremental_inserts_and_deletes() {
        let (pool, _dir) = test_pool().await;

        // Establish baseline with one entry.
        insert_block(&pool, "BLK01", "content", "first task").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-08-01' WHERE id = 'BLK01'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();
        assert_eq!(count_rows(&pool, "agenda_cache").await, 1, "baseline");

        // Add a second block with a due_date.
        insert_block(&pool, "BLK02", "content", "second task").await;
        sqlx::query("UPDATE blocks SET due_date = '2025-09-15' WHERE id = 'BLK02'")
            .execute(&pool)
            .await
            .unwrap();

        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();
        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            2,
            "incremental rebuild must insert the new entry"
        );

        // Soft-delete the first block — its cache entry becomes stale.
        soft_delete_block(&pool, "BLK01").await;
        rebuild_agenda_cache_split(&pool, &pool).await.unwrap();

        assert_eq!(
            count_rows(&pool, "agenda_cache").await,
            1,
            "incremental rebuild must delete the stale entry"
        );
    }

    #[tokio::test]
    async fn block_links_split_basic_reindex() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "See [[01HZ00000000000000000000AB]] and [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "both link targets must be indexed");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000CD");
    }

    #[tokio::test]
    async fn block_links_split_incremental_diff() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target A").await;
        insert_block(&pool, "01HZ00000000000000000000CD", "content", "target B").await;
        insert_block(&pool, "01HZ00000000000000000000EF", "content", "target C").await;

        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000CD]]",
        )
        .await;

        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();
        assert_eq!(count_rows(&pool, "block_links").await, 2, "initial: A + B");

        // Update content: remove B, add C
        sqlx::query!(
            "UPDATE blocks SET content = ? WHERE id = ?",
            "[[01HZ00000000000000000000AB]] [[01HZ00000000000000000000EF]]",
            "01HZ0000000000000000000SRC",
        )
        .execute(&pool)
        .await
        .unwrap();

        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        let rows = sqlx::query!(
            "SELECT target_id FROM block_links WHERE source_id = ? ORDER BY target_id",
            "01HZ0000000000000000000SRC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2, "diff: A kept, B removed, C added");
        assert_eq!(rows[0].target_id, "01HZ00000000000000000000AB");
        assert_eq!(rows[1].target_id, "01HZ00000000000000000000EF");
    }

    #[tokio::test]
    async fn block_links_split_deleted_source_clears_all() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "01HZ00000000000000000000AB", "content", "target").await;
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            "[[01HZ00000000000000000000AB]]",
        )
        .await;

        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();
        assert_eq!(count_rows(&pool, "block_links").await, 1);

        soft_delete_block(&pool, "01HZ0000000000000000000SRC").await;
        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "all links must be removed when source is soft-deleted"
        );
    }

    #[tokio::test]
    async fn block_links_split_nonexistent_source_is_noop() {
        let (pool, _dir) = test_pool().await;

        reindex_block_links_split(&pool, &pool, "NONEXISTENT0000000000000000")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "reindexing nonexistent block must not create links"
        );
    }

    #[tokio::test]
    async fn block_links_split_dangling_target_skipped() {
        let (pool, _dir) = test_pool().await;

        let nonexistent_ulid = "01HZ00000000000000NONEXIST";
        insert_block(
            &pool,
            "01HZ0000000000000000000SRC",
            "content",
            &format!("see [[{nonexistent_ulid}]] for details"),
        )
        .await;

        reindex_block_links_split(&pool, &pool, "01HZ0000000000000000000SRC")
            .await
            .unwrap();

        assert_eq!(
            count_rows(&pool, "block_links").await,
            0,
            "dangling [[ULID]] must not produce a block_links row"
        );
    }
}
