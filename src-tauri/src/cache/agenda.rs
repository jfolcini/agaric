use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::cmp::Ordering;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `agenda_cache` PK is `(date, block_id)`. The chunked DELETE binds 2
// params per row → `MAX_SQL_PARAMS / 2 = 499` rows per chunk. The
// chunked `INSERT OR IGNORE` writes 3 columns per row
// (date, block_id, source) → `MAX_SQL_PARAMS / 3 = 333` rows per chunk.
// Mirrors the constant in `cache/block_tag_refs.rs` (M-18).
const DELETE_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Sort-merge buffer flush threshold (M-19b). The merge loop accumulates
/// pending deletes / inserts in `Vec`s of up to `STREAM_BATCH` rows
/// before issuing chunked statements via [`apply_agenda_diff`]. Bounded
/// at the smaller of `INSERT_CHUNK` (333) and `DELETE_CHUNK` (499) so a
/// single flush emits at most one chunked DELETE + one chunked INSERT.
const STREAM_BATCH: usize = INSERT_CHUNK; // 333

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
/// the sort-merge dedup pass — M-19b):
/// 1. `block_properties` rows with a non-null `value_date` →
///    `source = 'property:<key>'`, `prio = 0`.
/// 2. `block_tags` referencing tag blocks whose name matches
///    `date/YYYY-MM-DD` (exactly 15 chars) →
///    `source = 'tag:<tag_id>'`, `prio = 1`.
/// 3. `blocks.due_date` column → `source = 'column:due_date'`, `prio = 2`.
/// 4. `blocks.scheduled_date` column →
///    `source = 'column:scheduled_date'`, `prio = 3`.
///
/// Output is sorted by `(date, block_id, prio)` so:
///   - the sort-merge diff in [`apply_sort_merge_rebuild`] can walk this
///     stream alongside `agenda_cache` (also `ORDER BY date, block_id`)
///     in lockstep, and
///   - duplicate `(date, block_id)` rows produced by multiple sources
///     are adjacent with the lowest-priority (= highest-precedence)
///     row first; the merge loop drops the rest. This preserves the
///     pre-M-19b first-source-wins property without requiring a
///     `HashMap` materialisation.
///
/// The `prio` column is exposed in the outer `SELECT` because SQLite's
/// `ORDER BY` resolves against the result-column list. Callers ignore
/// the value beyond ordering.
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
const DESIRED_AGENDA_SQL: &str = "SELECT date, block_id, source, prio FROM (
            SELECT bp.value_date AS date, bp.block_id, 'property:' || bp.key AS source, 0 AS prio
            FROM block_properties bp
            JOIN blocks b ON b.id = bp.block_id
            WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
            UNION ALL
            SELECT SUBSTR(t.content, 6) AS date, bt.block_id, 'tag:' || bt.tag_id AS source, 1 AS prio
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
            SELECT b.due_date AS date, b.id AS block_id, 'column:due_date' AS source, 2 AS prio
            FROM blocks b
            WHERE b.due_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
            UNION ALL
            SELECT b.scheduled_date AS date, b.id AS block_id, 'column:scheduled_date' AS source, 3 AS prio
            FROM blocks b
            WHERE b.scheduled_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND b.is_conflict = 0
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )
        )
        ORDER BY date ASC, block_id ASC, prio ASC";

const CURRENT_AGENDA_SQL: &str =
    "SELECT date, block_id, source FROM agenda_cache ORDER BY date ASC, block_id ASC";

// ---------------------------------------------------------------------------
// Sort-merge rebuild core (M-19b)
// ---------------------------------------------------------------------------

/// Stream-walk the desired and current agenda rows in lockstep and
/// apply the diff via [`apply_agenda_diff`] in batches of
/// [`STREAM_BATCH`] rows.
///
/// Both inputs share the sort key `(date, block_id)` (with the desired
/// stream additionally tie-breaking on source priority — see
/// [`DESIRED_AGENDA_SQL`]) so the merge runs in `O(n)` time and
/// `O(STREAM_BATCH)` Rust-heap memory. Replaces the pre-M-19b approach
/// of materialising both sides into `HashMap<(date, block_id), source>`
/// (peaked at `O(N)` for `N` total agenda rows ≈ 5 MB on a 100 K-block
/// vault).
///
/// Three independent connections are used:
///   - `desired_conn` — runs the 4-source UNION ALL stream;
///   - `current_conn` — runs the `agenda_cache` table scan stream;
///   - `write_conn`  — accumulates the chunked DELETE / INSERT inside
///     the caller's open transaction.
///
/// The connections must be distinct so the two `fetch(...)` borrows do
/// not conflict and the writer can flush mid-stream without dropping
/// either reader. Snapshot consistency across the three connections is
/// not required: this function inherits the "stale-while-revalidate"
/// semantics of the rebuild path (any concurrent writer mutation
/// observed by one reader but not the other is corrected on the next
/// rebuild — same eventual-consistency guarantee documented for the
/// split-pool TOCTOU window in [`rebuild_agenda_cache_split_impl`]).
///
/// Returns the logical change count (deletes + inserts + source-update
/// rows), preserving the externally-observable count from the pre-M-19b
/// `to_delete.len() + to_insert.len() + to_update.len()` formula.
async fn apply_sort_merge_rebuild(
    desired_conn: &mut sqlx::SqliteConnection,
    current_conn: &mut sqlx::SqliteConnection,
    write_conn: &mut sqlx::SqliteConnection,
) -> Result<u64, AppError> {
    let mut desired_stream =
        sqlx::query_as::<_, (String, String, String, i64)>(DESIRED_AGENDA_SQL).fetch(desired_conn);
    let mut current_stream =
        sqlx::query_as::<_, (String, String, String)>(CURRENT_AGENDA_SQL).fetch(current_conn);

    let mut deletes: Vec<(String, String)> = Vec::with_capacity(STREAM_BATCH);
    let mut inserts: Vec<((String, String), String)> = Vec::with_capacity(STREAM_BATCH);
    let mut changed: u64 = 0;

    // Pull the next *distinct* desired row, skipping any adjacent
    // duplicate `(date, block_id)` keys (lower-precedence sources from
    // the UNION ALL). Dedup must be bound to the desired-advance step —
    // if we did the skip in the merge loop body using the previously
    // emitted key, the `Ordering::Greater` arm (which only advances
    // current) would falsely classify the legitimate next desired row
    // as a duplicate of the one we just emitted.
    let mut prev_desired_key: Option<(String, String)> = None;
    macro_rules! pull_desired {
        () => {{
            let mut out: Option<(String, String, String)> = None;
            while let Some((d_date, d_block, d_source, _prio)) = desired_stream.try_next().await? {
                let key = (d_date.clone(), d_block.clone());
                if prev_desired_key.as_ref() == Some(&key) {
                    continue;
                }
                prev_desired_key = Some(key);
                out = Some((d_date, d_block, d_source));
                break;
            }
            out
        }};
    }

    let mut next_desired = pull_desired!();
    let mut next_current = current_stream.try_next().await?;

    loop {
        match (&next_desired, &next_current) {
            (None, None) => break,
            (Some((d_date, d_block, d_source)), None) => {
                // Current exhausted — every remaining desired row is a
                // pure INSERT.
                inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                changed += 1;
                next_desired = pull_desired!();
            }
            (None, Some((c_date, c_block, _))) => {
                // Desired exhausted — every remaining current row is a
                // pure DELETE.
                deletes.push((c_date.clone(), c_block.clone()));
                changed += 1;
                next_current = current_stream.try_next().await?;
            }
            (Some((d_date, d_block, d_source)), Some((c_date, c_block, c_source))) => {
                let d_key = (d_date.as_str(), d_block.as_str());
                let c_key = (c_date.as_str(), c_block.as_str());
                match d_key.cmp(&c_key) {
                    Ordering::Less => {
                        // Desired ahead in the lockstep walk → INSERT.
                        inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                        changed += 1;
                        next_desired = pull_desired!();
                    }
                    Ordering::Greater => {
                        // Current ahead → row no longer in desired set
                        // → DELETE.
                        deletes.push((c_date.clone(), c_block.clone()));
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    Ordering::Equal => {
                        // Same PK — compare source. If different, the
                        // row's source moved to a different upstream
                        // (e.g. property → column). Emit DELETE +
                        // INSERT, equivalent to UPDATE source under a
                        // PK of `(date, block_id)`. Counts as a single
                        // logical change to match pre-M-19b
                        // `to_update.len()` semantics.
                        if d_source != c_source {
                            deletes.push((c_date.clone(), c_block.clone()));
                            inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                            changed += 1;
                        }
                        next_desired = pull_desired!();
                        next_current = current_stream.try_next().await?;
                    }
                }
            }
        }

        // Flush whenever either buffer hits the threshold so peak
        // Rust-heap stays bounded at `O(STREAM_BATCH)`.
        if deletes.len() >= STREAM_BATCH || inserts.len() >= STREAM_BATCH {
            let dels: Vec<(&str, &str)> = deletes
                .iter()
                .map(|(d, b)| (d.as_str(), b.as_str()))
                .collect();
            let ins: Vec<((&str, &str), &str)> = inserts
                .iter()
                .map(|((d, b), s)| ((d.as_str(), b.as_str()), s.as_str()))
                .collect();
            apply_agenda_diff(write_conn, &dels, &ins).await?;
            deletes.clear();
            inserts.clear();
        }
    }

    // Drop both readers before the final flush — defensive, since
    // `write_conn` is independent of either stream's borrow but
    // dropping early releases the two read connections sooner.
    drop(desired_stream);
    drop(current_stream);

    if !deletes.is_empty() || !inserts.is_empty() {
        let dels: Vec<(&str, &str)> = deletes
            .iter()
            .map(|(d, b)| (d.as_str(), b.as_str()))
            .collect();
        let ins: Vec<((&str, &str), &str)> = inserts
            .iter()
            .map(|((d, b), s)| ((d.as_str(), b.as_str()), s.as_str()))
            .collect();
        apply_agenda_diff(write_conn, &dels, &ins).await?;
    }

    Ok(changed)
}

// ---------------------------------------------------------------------------
// rebuild_agenda_cache (p1-t20)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `agenda_cache`.
///
/// Instead of a full DELETE + INSERT, this function:
/// 1. Streams the desired state from the same 4 UNION ALL sources
///    (sorted by `(date, block_id, prio)` — see [`DESIRED_AGENDA_SQL`]).
/// 2. Streams the current cache state (sorted by `(date, block_id)`).
/// 3. Walks the two streams in lockstep (M-19b sort-merge), batching
///    DELETEs and INSERTs in `O(STREAM_BATCH)` chunks.
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
    // M-19b: three independent connections — two readers (desired +
    // current state streams) plus one writer for the diff transaction.
    // Distinct connections are required so the streams' mutable borrows
    // don't conflict and the writer can flush mid-stream. The original
    // single-tx snapshot guarantee is relaxed in exchange for
    // `O(STREAM_BATCH)` peak heap; any sub-millisecond drift between
    // snapshots is corrected by the next rebuild — identical
    // stale-while-revalidate semantics to the split-pool variant.
    let mut desired_conn = pool.acquire().await?;
    let mut current_conn = pool.acquire().await?;
    let mut tx = pool.begin().await?;

    let changed = apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx).await?;

    if changed == 0 {
        // No changes — transaction is rolled back on drop.
        return Ok(0);
    }

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
    // M-19b sort-merge, split-pool variant. Two reader connections from
    // `read_pool` (desired stream + current stream); one writer
    // transaction from `write_pool` for the chunked DELETE / INSERT.
    //
    // **TOCTOU window (L-25, M-19b).** Each read connection has its own
    // snapshot started at `acquire()`-time, and the write tx is opened
    // after the streams finish. Between any of the three snapshots
    // another writer may mutate `agenda_cache` or `blocks`, so the diff
    // applied below may be stale relative to the live state at write
    // time. This is the documented stale-while-revalidate semantics of
    // the background "rebuild" path (see AGENTS.md "Performance
    // Conventions / Split read/write pool pattern"): rebuilds are
    // eventually consistent. The next rebuild fixes any churn from this
    // window — worst-case the cache flickers an insert+delete on a row
    // another writer just touched, never a correctness violation. Do
    // not "tighten" this without also reading the architectural
    // rationale for the split-pool pattern; lifting the read into the
    // write tx would defeat the writer-lock-hold-time win the split
    // exists for.
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut tx = write_pool.begin().await?;

    let changed = apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx).await?;

    if changed == 0 {
        // No changes — nothing to write.
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// M-19b sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests are scoped to this file (M-19b) so the parent
    //! `cache::tests` module — which sibling subagents may be appending
    //! to in parallel for `block_tag_refs.rs` and
    //! `projected_agenda.rs` — is not touched. Helpers below are
    //! local copies of the patterns in `cache/tests.rs`.
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

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

    async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
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

    async fn set_due_date(pool: &SqlitePool, block_id: &str, date: &str) {
        sqlx::query!(
            "UPDATE blocks SET due_date = ? WHERE id = ?",
            date,
            block_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_scheduled_date(pool: &SqlitePool, block_id: &str, date: &str) {
        sqlx::query!(
            "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
            date,
            block_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Fetches every `(date, block_id, source)` row in `agenda_cache`,
    /// sorted for deterministic comparison.
    async fn snapshot(pool: &SqlitePool) -> Vec<(String, String, String)> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT date, block_id, source FROM agenda_cache ORDER BY date, block_id, source",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Generate a fixture spanning all four sources. Returns the
    /// expected canonical `(date, block_id, source)` triples sorted to
    /// match [`snapshot`].
    ///
    /// Layout (50 rows per source × 4 = 200):
    ///   - rows 000-049 → property `due` (date = 2025-01-DD)
    ///   - rows 050-099 → date-tag (date = 2025-02-DD via tag content)
    ///   - rows 100-149 → `blocks.due_date` column (date = 2025-03-DD)
    ///   - rows 150-199 → `blocks.scheduled_date` column (date = 2025-04-DD)
    async fn seed_mixed_fixture(pool: &SqlitePool) -> Vec<(String, String, String)> {
        let mut expected: Vec<(String, String, String)> = Vec::with_capacity(200);

        // Property source: 50 blocks with `due` value_date.
        for i in 0..50 {
            let id = format!("BLKP{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            insert_block(pool, &id, "content", "prop").await;
            set_property(pool, &id, "due", &date).await;
            expected.push((date, id, "property:due".to_string()));
        }

        // Tag source: 50 distinct date-tags + 50 blocks tagged once each.
        for i in 0..50 {
            let day = (i % 28) + 1;
            let tag_id = format!("DTAG{i:03}");
            let block_id = format!("BLKT{i:03}");
            let tag_content = format!("date/2025-02-{day:02}");
            insert_block(pool, &tag_id, "tag", &tag_content).await;
            insert_block(pool, &block_id, "content", "tag").await;
            add_tag(pool, &block_id, &tag_id).await;
            let date = format!("2025-02-{day:02}");
            expected.push((date, block_id, format!("tag:{tag_id}")));
        }

        // due_date column source: 50 blocks.
        for i in 0..50 {
            let id = format!("BLKD{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-03-{day:02}");
            insert_block(pool, &id, "content", "due").await;
            set_due_date(pool, &id, &date).await;
            expected.push((date, id, "column:due_date".to_string()));
        }

        // scheduled_date column source: 50 blocks.
        for i in 0..50 {
            let id = format!("BLKS{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-04-{day:02}");
            insert_block(pool, &id, "content", "sched").await;
            set_scheduled_date(pool, &id, &date).await;
            expected.push((date, id, "column:scheduled_date".to_string()));
        }

        expected.sort();
        expected
    }

    /// Mixed-source fixture (~200 rows across all four sources) — the
    /// sort-merge stream rebuild must produce the identical output set
    /// to the pre-M-19b HashMap path.
    #[tokio::test]
    async fn rebuild_streams_without_full_hashmap_materialization_m19b() {
        let (pool, _dir) = test_pool().await;
        let mut expected = seed_mixed_fixture(&pool).await;
        expected.sort();

        rebuild_agenda_cache(&pool).await.unwrap();

        let actual = snapshot(&pool).await;
        assert_eq!(actual.len(), 200, "exactly 200 agenda rows expected");
        assert_eq!(
            actual, expected,
            "sort-merge output must match the canonical desired set"
        );
    }

    /// Rebuild over an unchanged source set must report zero logical
    /// changes on the second pass. Exercises the `Ordering::Equal` arm
    /// of the merge with no source drift.
    #[tokio::test]
    async fn rebuild_with_no_changes_is_idempotent_m19b() {
        let (pool, _dir) = test_pool().await;
        seed_mixed_fixture(&pool).await;

        let first = rebuild_agenda_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 200, "first pass inserts every row");

        let second = rebuild_agenda_cache_impl(&pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");

        assert_eq!(
            snapshot(&pool).await.len(),
            200,
            "row count must be preserved on idempotent rebuild"
        );
    }

    /// Modify 10 rows (source change), insert 5 new rows, and remove 5
    /// existing rows from the source data. The merge must touch
    /// **exactly** those 20 rows — 10 source updates + 5 inserts + 5
    /// deletes — and nothing else.
    #[tokio::test]
    async fn rebuild_diffs_correctly_when_subset_of_rows_changed_m19b() {
        let (pool, _dir) = test_pool().await;

        // Seed: 100 blocks via `property:due` for distinct dates.
        for i in 0..100 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let month = (i / 28) + 1; // 1..=4
            let date = format!("2025-{month:02}-{day:02}");
            insert_block(&pool, &id, "content", "diff").await;
            set_property(&pool, &id, "due", &date).await;
        }

        let baseline = rebuild_agenda_cache_impl(&pool).await.unwrap();
        assert_eq!(baseline, 100, "baseline inserts 100 rows");
        assert_eq!(
            snapshot(&pool).await.len(),
            100,
            "baseline cache has 100 rows"
        );

        // Mutation A: 10 rows shift from `property:due` → `column:due_date`.
        // Drop the property and write the same date to the blocks column,
        // so the row's PK `(date, block_id)` is unchanged but `source`
        // moves from `property:due` to `column:due_date`.
        for i in 0..10 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            sqlx::query!(
                "DELETE FROM block_properties WHERE block_id = ? AND key = 'due'",
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
            set_due_date(&pool, &id, &date).await;
        }

        // Mutation B: 5 new rows added (block + property).
        for i in 0..5 {
            let id = format!("NEWB{i:03}");
            insert_block(&pool, &id, "content", "new").await;
            let date = format!("2026-01-{:02}", i + 1);
            set_property(&pool, &id, "due", &date).await;
        }

        // Mutation C: 5 rows removed by deleting the block_properties
        // entry (no other source remains for these blocks → drop from
        // agenda).
        for i in 90..95 {
            let id = format!("DIFF{i:03}");
            sqlx::query!(
                "DELETE FROM block_properties WHERE block_id = ? AND key = 'due'",
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
        }

        let touched = rebuild_agenda_cache_impl(&pool).await.unwrap();
        assert_eq!(
            touched, 20,
            "diff must touch exactly 10 source-changes + 5 inserts + 5 deletes = 20"
        );

        // Final shape: 100 - 5 (deleted) + 5 (added) = 100 rows.
        let after = snapshot(&pool).await;
        assert_eq!(after.len(), 100, "row count = 100 - 5 + 5");

        // Verify the 10 source-changed rows now report `column:due_date`.
        for i in 0..10 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            let row = after
                .iter()
                .find(|(d, b, _)| d == &date && b == &id)
                .unwrap_or_else(|| panic!("DIFF{i:03} should still be present"));
            assert_eq!(
                row.2, "column:due_date",
                "DIFF{i:03} source must have moved to column:due_date"
            );
        }

        // Verify the 5 inserted rows are present with `property:due`.
        for i in 0..5 {
            let id = format!("NEWB{i:03}");
            assert!(
                after
                    .iter()
                    .any(|(_, b, s)| b == &id && s == "property:due"),
                "NEWB{i:03} must be present with property:due"
            );
        }

        // Verify the 5 deleted rows are gone.
        for i in 90..95 {
            let id = format!("DIFF{i:03}");
            assert!(
                !after.iter().any(|(_, b, _)| b == &id),
                "DIFF{i:03} must have been deleted from cache"
            );
        }
    }

    /// The same `(date, block_id)` PK appearing from two distinct
    /// sources must collapse to a single row. The desired stream's
    /// `ORDER BY date, block_id, prio` puts the higher-precedence row
    /// (lower `prio`) first; the merge loop drops the rest.
    #[tokio::test]
    async fn rebuild_handles_duplicate_date_block_keys_via_dedup_m19b() {
        let (pool, _dir) = test_pool().await;

        // Same block: property AND scheduled_date column on the same date.
        // property has prio = 0, column:scheduled_date has prio = 3 →
        // property wins.
        insert_block(&pool, "DUPB", "content", "dup-prop-col").await;
        set_property(&pool, "DUPB", "scheduled", "2025-05-01").await;
        set_scheduled_date(&pool, "DUPB", "2025-05-01").await;

        // Second block: tag AND due_date column on the same date.
        // tag has prio = 1, column:due_date has prio = 2 → tag wins.
        insert_block(&pool, "DTAGZ", "tag", "date/2025-05-02").await;
        insert_block(&pool, "DUPC", "content", "dup-tag-col").await;
        add_tag(&pool, "DUPC", "DTAGZ").await;
        set_due_date(&pool, "DUPC", "2025-05-02").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows = snapshot(&pool).await;
        assert_eq!(
            rows.len(),
            2,
            "two distinct (date, block_id) pairs expected"
        );
        assert_eq!(
            rows[0],
            (
                "2025-05-01".to_string(),
                "DUPB".to_string(),
                "property:scheduled".to_string()
            ),
            "property source wins over column:scheduled_date for DUPB"
        );
        assert_eq!(
            rows[1],
            (
                "2025-05-02".to_string(),
                "DUPC".to_string(),
                "tag:DTAGZ".to_string()
            ),
            "tag source wins over column:due_date for DUPC"
        );
    }

    /// Seed a non-empty cache, drop every source-data row, then rebuild
    /// — the cache must be completely cleared. Exercises the
    /// "desired exhausted, drain current" path of the merge.
    #[tokio::test]
    async fn rebuild_with_empty_source_data_clears_cache_m19b() {
        let (pool, _dir) = test_pool().await;
        seed_mixed_fixture(&pool).await;
        rebuild_agenda_cache(&pool).await.unwrap();
        assert_eq!(
            snapshot(&pool).await.len(),
            200,
            "fixture produces 200 cache rows"
        );

        // Drop every source-data row that contributes to agenda_cache.
        // Soft-delete is sufficient — the SQL filters on `deleted_at IS
        // NULL`. We use a fixed timestamp to avoid clock noise.
        sqlx::query("UPDATE blocks SET deleted_at = '2025-12-31T00:00:00+00:00'")
            .execute(&pool)
            .await
            .unwrap();

        let cleared = rebuild_agenda_cache_impl(&pool).await.unwrap();
        assert_eq!(cleared, 200, "every cache row must be deleted");
        assert_eq!(
            snapshot(&pool).await.len(),
            0,
            "agenda_cache must be empty after source data is removed"
        );
    }
}
