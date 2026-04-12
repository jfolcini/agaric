use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::error::AppError;

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
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

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
