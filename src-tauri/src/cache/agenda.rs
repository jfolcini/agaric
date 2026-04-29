use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `agenda_cache` PK is `(date, block_id)`. The chunked DELETE binds 2
// params per row → `MAX_SQL_PARAMS / 2 = 499` rows per chunk. The
// chunked `INSERT OR IGNORE` writes 3 columns per row
// (date, block_id, source) → `MAX_SQL_PARAMS / 3 = 333` rows per chunk.
// Mirrors the constant in `cache/block_tag_refs.rs` (M-18).
const DELETE_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Apply an agenda diff inside an open transaction in chunks bounded by
/// [`MAX_SQL_PARAMS`] (M-18).
///
/// Plan (a) from the M-18 fix: UPDATEs are folded into the merged
/// DELETE + INSERT lists. The PK is `(date, block_id)` so DELETE+INSERT
/// is equivalent to UPDATE on `source` — and avoids a specialised
/// chunked UPDATE statement.
///
/// `delete_rows` and `insert_rows` are caller-owned and may be empty;
/// each chunk emits a single multi-row statement so a 1000-row diff
/// produces 2 DELETEs + 3 INSERTs instead of 1000 individual statements.
async fn apply_agenda_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_rows: &[(&str, &str)],
    insert_rows: &[((&str, &str), &str)],
) -> Result<(), AppError> {
    for chunk in delete_rows.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "DELETE FROM agenda_cache WHERE (date, block_id) IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (date, block_id) in chunk {
            q = q.bind(date).bind(block_id);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO agenda_cache (date, block_id, source) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for ((date, block_id), source) in chunk {
            q = q.bind(date).bind(block_id).bind(source);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Desired-state SQL (L-27)
// ---------------------------------------------------------------------------

/// 4-source UNION ALL projection that computes the desired state of
/// `agenda_cache` from the live database. Bound from both
/// [`rebuild_agenda_cache_impl`] (single-pool) and
/// [`rebuild_agenda_cache_split_impl`] (read/write-split) so the two
/// implementations cannot silently diverge — any change to the
/// template-page filter, source semantics, or new column source is made
/// in exactly one place.
///
/// Sources, in order (first-wins on PK `(date, block_id)` after
/// in-memory deduplication):
/// 1. `block_properties` rows with a non-null `value_date` →
///    `source = 'property:<key>'`.
/// 2. `block_tags` referencing tag blocks whose name matches
///    `date/YYYY-MM-DD` (exactly 15 chars) →
///    `source = 'tag:<tag_id>'`.
/// 3. `blocks.due_date` column → `source = 'column:due_date'`.
/// 4. `blocks.scheduled_date` column → `source = 'column:scheduled_date'`.
///
/// Template-page filter (FEAT-5a): every source excludes blocks whose
/// owning page (`b.page_id`, denormalised by migration 0027) carries a
/// `template` property, so the agenda surface — and the Google Calendar
/// push layer that consumes it — never sees template scaffolding.
/// Top-level tags have `page_id IS NULL` and pass the `NOT EXISTS`
/// check vacuously.
///
/// Conflict-aware (`is_conflict = 0` on every block reference,
/// invariant #9). Soft-deleted rows excluded.
const DESIRED_AGENDA_SQL: &str = "SELECT date, block_id, source FROM (
            SELECT bp.value_date AS date, bp.block_id, 'property:' || bp.key AS source
            FROM block_properties bp
            JOIN blocks b ON b.id = bp.block_id
            WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
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
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
            UNION ALL
            SELECT b.due_date AS date, b.id AS block_id, 'column:due_date' AS source
            FROM blocks b
            WHERE b.due_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
            UNION ALL
            SELECT b.scheduled_date AS date, b.id AS block_id, 'column:scheduled_date' AS source
            FROM blocks b
            WHERE b.scheduled_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
        )";

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
    super::rebuild_with_timing("agenda", || rebuild_agenda_cache_impl(pool)).await
}

async fn rebuild_agenda_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = pool.begin().await?;

    // Step 1: Compute desired state from the same 4 UNION ALL sources.
    // Properties appear first so they win on PK deduplication (first-wins,
    // replicating INSERT OR IGNORE semantics). Source-of-truth SQL lives
    // in [`DESIRED_AGENDA_SQL`] so this branch and the read/write-split
    // branch cannot drift.
    let desired_rows: Vec<(String, String, String)> = sqlx::query_as(DESIRED_AGENDA_SQL)
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
        return Ok(0);
    }

    // Logical change count: preserve the externally-observed semantics
    // even though M-18 merges UPDATEs into the DELETE+INSERT chunks.
    let changed = (to_delete.len() + to_insert.len() + to_update.len()) as u64;

    // Step 4: Apply diff in chunks bounded by MAX_SQL_PARAMS (M-18).
    // UPDATEs collapse into DELETE+INSERT because the PK is
    // (date, block_id) — re-inserting with the new `source` is
    // equivalent to UPDATE source.
    let mut delete_rows: Vec<(&str, &str)> = Vec::with_capacity(to_delete.len() + to_update.len());
    delete_rows.extend(to_delete.iter().copied());
    delete_rows.extend(to_update.iter().map(|(k, _)| *k));

    let mut insert_rows: Vec<((&str, &str), &str)> =
        Vec::with_capacity(to_insert.len() + to_update.len());
    insert_rows.extend(to_insert.iter().copied());
    insert_rows.extend(to_update.iter().copied());

    apply_agenda_diff(&mut tx, &delete_rows, &insert_rows).await?;

    tx.commit().await?;
    Ok(changed)
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
    super::rebuild_with_timing("agenda", || {
        rebuild_agenda_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_agenda_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Read phase: snapshot-isolated transaction on the read pool so both
    // queries (desired state + current cache) see a consistent view.
    //
    // **TOCTOU window (L-25).** Unlike `rebuild_agenda_cache_impl` —
    // which holds a single tx across read+write on one pool — the split
    // variant intentionally drops `read_tx` (line ~250) before opening
    // the write tx on `write_pool`. Between drop and begin, another
    // writer may mutate `agenda_cache` or `blocks`, so the diff applied
    // below may be stale relative to the live state at write time.
    //
    // This is the documented stale-while-revalidate semantics of the
    // background "rebuild" path (see AGENTS.md "Performance Conventions
    // / Split read/write pool pattern"): rebuilds are eventually
    // consistent. The next rebuild fixes any churn from this window —
    // worst-case the cache flickers an insert+delete on a row another
    // writer just touched, never a correctness violation. Do not
    // "tighten" this without also reading the architectural rationale
    // for the split-pool pattern; lifting the read into the write tx
    // would defeat the writer-lock-hold-time win the split exists for.
    let mut read_tx = read_pool.begin().await?;

    // Step 1: Compute desired state from the same 4 UNION ALL sources.
    // Source-of-truth SQL lives in [`DESIRED_AGENDA_SQL`] so this branch
    // and the single-pool branch cannot drift (L-27).
    let desired_rows: Vec<(String, String, String)> = sqlx::query_as(DESIRED_AGENDA_SQL)
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
        return Ok(0);
    }

    // Logical change count: preserve the externally-observed semantics
    // even though M-18 merges UPDATEs into the DELETE+INSERT chunks.
    let changed = (to_delete.len() + to_insert.len() + to_update.len()) as u64;

    // Step 4: Apply diff on write pool, chunked (M-18). UPDATEs collapse
    // into DELETE+INSERT — the PK is (date, block_id), so re-inserting
    // with the new `source` is equivalent to UPDATE source.
    let mut delete_rows: Vec<(&str, &str)> = Vec::with_capacity(to_delete.len() + to_update.len());
    delete_rows.extend(to_delete.iter().copied());
    delete_rows.extend(to_update.iter().map(|(k, _)| *k));

    let mut insert_rows: Vec<((&str, &str), &str)> =
        Vec::with_capacity(to_insert.len() + to_update.len());
    insert_rows.extend(to_insert.iter().copied());
    insert_rows.extend(to_update.iter().copied());

    let mut tx = write_pool.begin().await?;
    apply_agenda_diff(&mut tx, &delete_rows, &insert_rows).await?;
    tx.commit().await?;
    Ok(changed)
}
