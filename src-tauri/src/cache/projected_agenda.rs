use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// `projected_agenda_cache` has 3 columns per row
/// (block_id, projected_date, source) → `MAX_SQL_PARAMS / 3 = 333` rows
/// per chunked `INSERT OR IGNORE` (M-18). Mirrors the constant naming in
/// `cache/tags.rs` and `cache/pages.rs` for consistency across split-pool
/// rebuilds.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Buffer-flush threshold for the chunk-flush rebuild path (M-19).
///
/// The pre-M-19 rebuild buffered every projection for every repeating
/// block (up to `repeating_blocks × 365-day horizon ≈ tens of thousands
/// of entries`) into a single `Vec<(String, String, String)>` before
/// flushing to the DB. Peak Rust-heap was `O(repeating_blocks × horizon)`
/// — ~18MB on a 1000-block × 365-day vault, larger on Android where the
/// memory ceiling is tighter (REVIEW-LATER M-19).
///
/// The post-M-19 rebuild appends per-block projections into a working
/// buffer and flushes the buffer to the DB once it crosses
/// `CHUNK_SIZE` entries, then clears the buffer and continues with the
/// next block. Peak buffer memory is `CHUNK_SIZE + max-projections-per-block`
/// (≤ ~10K + ~730 entries) ⇒ ~500KB instead of ~18MB.
///
/// Trade-off: chunk-flushing means a partial rebuild that fails after
/// the first flush would leave the cache half-written if the rebuild
/// were not transactional. The rebuild keeps DELETE + every chunked
/// INSERT inside a single transaction so a partial-flush crash rolls
/// back cleanly — atomicity is preserved (AGENTS.md "CQRS hybrid model"
/// invariant + the M-19 spec callout). The chunk size is large enough
/// that the per-flush overhead is amortised but small enough to keep
/// peak memory bounded.
const CHUNK_SIZE: usize = 10_000;

// ---------------------------------------------------------------------------
// rebuild_projected_agenda_cache (P-16)
// ---------------------------------------------------------------------------

/// Row returned by the repeating-blocks query inside the cache rebuild.
///
/// Mirrors `RepeatingBlockRow` in `commands/mod.rs` but lives here to avoid
/// a circular dependency (cache -> commands).
///
/// `#[derive(sqlx::FromRow)]` lets the split-pool rebuild use the dynamic
/// `sqlx::query_as` (no compile-time SQL check) while the single-pool
/// rebuild still uses the `sqlx::query_as!` macro.  Both decode into the
/// same struct so the shared compute helper sees identical inputs.
#[derive(sqlx::FromRow)]
struct CacheRepeatingRow {
    id: String,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    repeat_rule: Option<String>,
    repeat_until: Option<String>,
    repeat_count: Option<f64>,
    repeat_seq: Option<f64>,
}

/// Full recompute of `projected_agenda_cache`.
///
/// 1. Fetches all repeating blocks (non-DONE, non-deleted, has repeat property,
///    has at least one date column).
/// 2. For each block, projects dates for the next 365 days from today.
/// 3. Respects end conditions (repeat-until, repeat-count).
/// 4. Writes projected entries via DELETE + INSERT in a single transaction.
///
/// # Time-zone semantics (L-26)
///
/// `today` and the 365-day projection horizon are anchored to the **device's
/// local timezone** via [`chrono::Local::now`].  This means a multi-device
/// user whose devices are configured to different timezones will see slight
/// per-device divergence in `projected_agenda_cache` contents around midnight
/// — a block whose next occurrence falls on a date that is "today" in
/// timezone A but already "tomorrow" in timezone B may be projected one row
/// earlier on device A than on device B until the next rebuild.
///
/// The divergence is **acceptable under the single-user threat model**
/// described in `AGENTS.md` — agenda projections are an eventually-consistent
/// read-side cache rebuilt locally per device, so the skew self-corrects on
/// the next rebuild past the time boundary.  Users in practice think in
/// local time, so anchoring to local time matches user expectations.
///
/// Switching to UTC would eliminate the per-device divergence but at the cost
/// of producing projections whose date column does not match the user's
/// calendar day on either side of midnight, which is a more visible
/// behaviour change.  See `REVIEW-LATER.md` L-26 for the conditional fix:
/// either document (this comment) or normalise to UTC consistently.  The
/// documentation path was chosen per the AGENTS.md "Architectural Stability"
/// guidance.
pub async fn rebuild_projected_agenda_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("projected_agenda", || {
        rebuild_projected_agenda_cache_impl(pool)
    })
    .await
}

async fn rebuild_projected_agenda_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let today = chrono::Local::now().date_naive();
    // Pre-compute projections for the next 365 days only. Queries beyond this
    // horizon fall back to on-the-fly computation (which is slower but correct).
    // 365 days is sufficient for weekly/monthly calendar views — the primary
    // consumer of projected agenda data.
    let horizon = today + chrono::Duration::days(365);

    // Fetch all repeating blocks (same query as list_projected_agenda_inner).
    // Template-page filter (FEAT-5a, spec line 812): exclude repeating
    // blocks whose owning page carries a `template` property so they
    // never enter the projected agenda.  `b.page_id` is the denormalised
    // root-page column (migration 0027).
    let rows: Vec<CacheRepeatingRow> = sqlx::query_as!(
        CacheRepeatingRow,
        r#"SELECT b.id,
                b.due_date, b.scheduled_date,
                bp.value_text AS repeat_rule,
                bp_until.value_date AS repeat_until,
                bp_count.value_num AS repeat_count,
                bp_seq.value_num AS repeat_seq
         FROM blocks b
         JOIN block_properties bp ON bp.block_id = b.id AND bp.key = 'repeat'
         LEFT JOIN block_properties bp_until ON bp_until.block_id = b.id AND bp_until.key = 'repeat-until'
         LEFT JOIN block_properties bp_count ON bp_count.block_id = b.id AND bp_count.key = 'repeat-count'
         LEFT JOIN block_properties bp_seq ON bp_seq.block_id = b.id AND bp_seq.key = 'repeat-seq'
         WHERE b.deleted_at IS NULL
           AND b.is_conflict = 0
           AND (b.todo_state IS NULL OR b.todo_state != 'DONE')
           AND bp.value_text IS NOT NULL
           AND (b.due_date IS NOT NULL OR b.scheduled_date IS NOT NULL)
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )"#,
    )
    .fetch_all(pool)
    .await?;

    // Write to DB: DELETE + chunk-flushed INSERTs in a single
    // transaction.  Chunk-flushing (M-19) bounds peak Rust-heap to
    // `CHUNK_SIZE + max-per-block` instead of materialising every
    // projection up-front — see [`CHUNK_SIZE`] for the trade-off.
    // Atomicity: DELETE + every chunked INSERT live in the same `tx`,
    // so a partial-flush failure rolls back cleanly via the
    // `Transaction` Drop guard.
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;

    let written = project_and_write_chunked(&mut tx, today, horizon, &rows).await?;

    tx.commit().await?;
    Ok(written)
}

/// Drive the chunk-flush rebuild path (M-19) inside an open transaction.
///
/// Iterates `rows`, projecting each repeating block via
/// [`project_block_into`] into a working buffer.  Once the buffer
/// crosses [`CHUNK_SIZE`] entries the helper flushes it to `tx` via
/// [`flush_projection_chunk`] (which itself splits the flush into
/// `REBUILD_CHUNK`-row sub-chunks bounded by [`MAX_SQL_PARAMS`]) and
/// clears the buffer before continuing with the next block.  A final
/// flush drains any trailing entries.
///
/// Atomicity: every chunked `INSERT OR IGNORE` runs against the
/// caller-owned `tx`.  The caller is responsible for the DELETE that
/// runs before this helper and for committing the transaction on
/// success — a partial-flush failure here propagates an error and the
/// caller's `Transaction` Drop guard rolls the transaction back.
///
/// Both rebuild paths (single-pool + split) share this helper so the
/// chunk-flush + per-block projection logic cannot silently drift
/// between them (M-17 invariant #7).
async fn project_and_write_chunked(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    today: chrono::NaiveDate,
    horizon: chrono::NaiveDate,
    rows: &[CacheRepeatingRow],
) -> Result<u64, AppError> {
    // Pre-allocate a chunk-sized buffer plus headroom for one block's
    // worth of projections (the buffer can momentarily exceed
    // `CHUNK_SIZE` by up to one block before the next flush check).
    let mut buf: Vec<(String, String, String)> = Vec::with_capacity(CHUNK_SIZE + 1024);
    let mut written: u64 = 0;

    for block in rows {
        project_block_into(block, today, horizon, &mut buf);
        if buf.len() >= CHUNK_SIZE {
            flush_projection_chunk(tx, &buf).await?;
            written += buf.len() as u64;
            buf.clear();
        }
    }

    if !buf.is_empty() {
        flush_projection_chunk(tx, &buf).await?;
        written += buf.len() as u64;
        buf.clear();
    }

    Ok(written)
}

/// Flush a buffer of `(block_id, projected_date, source)` entries via
/// chunked multi-row `INSERT OR IGNORE` (M-18).
///
/// 3 columns per row, so each statement binds at most
/// `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS = 999` parameters. The caller
/// passes the open transaction's connection so all chunked INSERTs
/// accumulate in the same `tx` and a partial flush rolls back cleanly
/// (M-19 atomicity invariant).
async fn flush_projection_chunk(
    conn: &mut sqlx::SqliteConnection,
    entries: &[(String, String, String)],
) -> Result<(), AppError> {
    for chunk in entries.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO projected_agenda_cache \
             (block_id, projected_date, source) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (block_id, date, source) in chunk {
            q = q.bind(block_id).bind(date).bind(source);
        }
        q.execute(&mut *conn).await?;
    }
    Ok(())
}

/// Per-block projection compute step shared by the single-pool and
/// split-pool rebuilds.
///
/// Appends the `(block_id, projected_date, source)` entries for a single
/// repeating block to the caller-owned `out` buffer.  The recurrence
/// semantics (`dot_plus` / `plus_plus` / default modes, `repeat-until` /
/// `repeat-count` / `repeat-seq` end conditions, the 10 000-iteration
/// safety bound) are unchanged from the pre-M-19 `compute_projection_entries`
/// — the function was factored per-block so the rebuild path can
/// chunk-flush at block boundaries without buffering every projection
/// up-front (peak Rust-heap drops from `O(blocks × horizon)` to
/// `O(CHUNK_SIZE + max-per-block)`).
///
/// Both rebuild paths must produce **identical** entries for identical
/// inputs; keeping the recurrence logic in one helper removes the risk
/// of the two paths drifting (M-17 invariant #7).
fn project_block_into(
    block: &CacheRepeatingRow,
    today: chrono::NaiveDate,
    horizon: chrono::NaiveDate,
    out: &mut Vec<(String, String, String)>,
) {
    let rule = match &block.repeat_rule {
        Some(r) if !r.is_empty() => r.clone(),
        _ => return,
    };

    let repeat_until = block.repeat_until.clone();
    let repeat_count = block.repeat_count;
    let repeat_seq = block.repeat_seq;

    let until_date = repeat_until
        .as_deref()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

    // f64 → usize has no `TryFrom` in std; the cast is safe because
    // repeat_count and repeat_seq are non-negative f64 (whole numbers)
    // from SQLite.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let remaining = match (repeat_count, repeat_seq) {
        (Some(count), Some(seq)) if count > seq => Some((count - seq) as usize),
        (Some(count), None) => Some(count as usize),
        (Some(_), Some(_)) => Some(0usize),
        _ => None,
    };

    // Parse mode and interval from rule
    let trimmed = rule.trim().to_lowercase();
    let (mode, interval) = if let Some(rest) = trimmed.strip_prefix(".+") {
        ("dot_plus", rest)
    } else if let Some(rest) = trimmed.strip_prefix("++") {
        ("plus_plus", rest)
    } else {
        ("default", trimmed.as_str())
    };

    // Project for each date source (due_date, scheduled_date)
    let sources: Vec<(&str, &str)> = [
        block.due_date.as_deref().map(|d| ("due_date", d)),
        block
            .scheduled_date
            .as_deref()
            .map(|d| ("scheduled_date", d)),
    ]
    .into_iter()
    .flatten()
    .collect();

    for (source_name, date_str) in sources {
        let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
            continue;
        };

        // Determine starting point based on mode
        let mut current = match mode {
            "dot_plus" => today,
            "plus_plus" => {
                let mut c = base;
                for _ in 0..10_000 {
                    c = match crate::recurrence::shift_date_once(c, interval) {
                        Some(d) => d,
                        None => break,
                    };
                    if c > today {
                        break;
                    }
                }
                c
            }
            _ => base,
        };

        let mut projected_count = 0usize;
        let max_remaining = remaining.unwrap_or(usize::MAX);

        // For ++ mode, pre-add the caught-up date itself.
        if mode == "plus_plus"
            && projected_count < max_remaining
            && current >= today
            && current <= horizon
        {
            let skip = until_date.is_some_and(|until| current > until);
            if !skip {
                out.push((
                    block.id.clone(),
                    current.format("%Y-%m-%d").to_string(),
                    source_name.to_string(),
                ));
                projected_count += 1;
            }
        }

        // Safety limit to prevent infinite loops
        for _ in 0..10_000 {
            if projected_count >= max_remaining {
                break;
            }

            current = match crate::recurrence::shift_date_once(current, interval) {
                Some(d) => d,
                None => break,
            };

            if let Some(until) = until_date {
                if current > until {
                    break;
                }
            }

            if current > horizon {
                break;
            }

            if current >= today {
                out.push((
                    block.id.clone(),
                    current.format("%Y-%m-%d").to_string(),
                    source_name.to_string(),
                ));
                projected_count += 1;
            }
        }
    }
}

/// Read/write split variant of [`rebuild_projected_agenda_cache`] (M-17).
///
/// Reads repeating blocks from `read_pool` inside a snapshot-isolated
/// transaction, materialises them into memory, then runs `DELETE FROM
/// projected_agenda_cache` plus chunk-flushed `INSERT OR IGNORE` on
/// `write_pool` — every chunked INSERT accumulates in the same write
/// transaction so atomicity is preserved (M-19).
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks` / `block_properties`.
/// The next rebuild reconciles any churn — cache rebuilds are background,
/// eventually consistent (AGENTS.md "Performance Conventions / Split
/// read/write pool pattern").
///
/// M-19 chunk-flush: the per-block recurrence compute now runs
/// interleaved with the chunked INSERTs inside the write transaction
/// instead of buffering every projection up-front.  The writer lock is
/// held marginally longer (one extra block-projection per chunk
/// boundary) but peak Rust-heap drops from `O(blocks × horizon)` to
/// `O(CHUNK_SIZE + max-per-block)`.  See [`CHUNK_SIZE`] for the
/// trade-off.
///
/// L-26 timezone semantics: `today` is captured **before** the read tx
/// using [`chrono::Local::now`] so the entire rebuild — read, compute,
/// write — sees one stable reference date.  See
/// [`rebuild_projected_agenda_cache`] for the documentation pin on
/// device-local timezone behaviour.
pub async fn rebuild_projected_agenda_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("projected_agenda", || {
        rebuild_projected_agenda_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_projected_agenda_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Capture `today` + horizon **before** the read tx so every entry in
    // this rebuild shares one reference date — matches the single-pool
    // variant's semantics and the L-26 device-local-timezone pin.
    let today = chrono::Local::now().date_naive();
    let horizon = today + chrono::Duration::days(365);

    // Read phase — snapshot-isolated SELECT on `read_pool`. Same shape
    // and filters as `rebuild_projected_agenda_cache_impl`:
    // `is_conflict = 0`, `deleted_at IS NULL`, repeat property present,
    // at least one date column, template-page exclusion.
    let mut read_tx = read_pool.begin().await?;
    let rows: Vec<CacheRepeatingRow> = sqlx::query_as::<_, CacheRepeatingRow>(
        "SELECT b.id,
                b.due_date, b.scheduled_date,
                bp.value_text AS repeat_rule,
                bp_until.value_date AS repeat_until,
                bp_count.value_num AS repeat_count,
                bp_seq.value_num AS repeat_seq
         FROM blocks b
         JOIN block_properties bp ON bp.block_id = b.id AND bp.key = 'repeat'
         LEFT JOIN block_properties bp_until ON bp_until.block_id = b.id AND bp_until.key = 'repeat-until'
         LEFT JOIN block_properties bp_count ON bp_count.block_id = b.id AND bp_count.key = 'repeat-count'
         LEFT JOIN block_properties bp_seq ON bp_seq.block_id = b.id AND bp_seq.key = 'repeat-seq'
         WHERE b.deleted_at IS NULL
           AND b.is_conflict = 0
           AND (b.todo_state IS NULL OR b.todo_state != 'DONE')
           AND bp.value_text IS NOT NULL
           AND (b.due_date IS NOT NULL OR b.scheduled_date IS NOT NULL)
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )",
    )
    .fetch_all(&mut *read_tx)
    .await?;
    drop(read_tx);

    // Write phase — DELETE + chunk-flushed `INSERT OR IGNORE` on
    // `write_pool`, all wrapped in a single transaction (M-19).  The
    // per-block projection runs interleaved with the chunked INSERTs
    // via [`project_and_write_chunked`] so peak Rust-heap is bounded
    // by [`CHUNK_SIZE`] instead of `O(blocks × horizon)`.  Atomicity:
    // DELETE + every chunked INSERT live in the same `tx` — a
    // partial-flush failure rolls back cleanly via the `Transaction`
    // Drop guard.
    let mut tx = write_pool.begin().await?;

    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;

    let written = project_and_write_chunked(&mut tx, today, horizon, &rows).await?;

    tx.commit().await?;
    Ok(written)
}

// ---------------------------------------------------------------------------
// L-26 — local-timezone documentation pin
// ---------------------------------------------------------------------------

#[cfg(test)]
mod l26_tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// Sanity regression for L-26.
    ///
    /// Asserts that `rebuild_projected_agenda_cache` returns `Ok(())` on a
    /// freshly-migrated empty pool regardless of the device clock.  This
    /// pins the local-timezone semantics documented on
    /// [`rebuild_projected_agenda_cache`] without attempting clock injection
    /// — a fake clock would be a much larger refactor and is explicitly
    /// out of scope for the seating commit.  If a future change moves the
    /// projection horizon away from `chrono::Local::now()`, this test still
    /// passes; the doc-comment block remains the source of truth for
    /// timezone semantics.
    #[tokio::test]
    async fn projected_agenda_doc_pin_runs_cleanly_on_empty_pool() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        // Empty pool → no repeating blocks → cache rebuilds to zero rows
        // without error, irrespective of the wall-clock time of day.
        rebuild_projected_agenda_cache(&pool)
            .await
            .expect("empty-pool rebuild must succeed at any time-of-day");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projected_agenda_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "empty pool must produce zero projected entries");
    }

    /// Asserts the L-26 documentation block remains in place.
    ///
    /// The doc comment is the load-bearing artefact for L-26 (the code
    /// behaviour is unchanged).  This test reads the source file at
    /// compile time and fails loudly if a future refactor strips the
    /// timezone-semantics doc block, so the documentation cannot
    /// silently disappear.
    #[test]
    fn projected_agenda_local_timezone_doc_present() {
        let src = include_str!("projected_agenda.rs");
        assert!(
            src.contains("# Time-zone semantics (L-26)"),
            "L-26 timezone-semantics doc block must remain on \
             rebuild_projected_agenda_cache"
        );
        assert!(
            src.contains("device's\n/// local timezone"),
            "L-26 doc must call out device-local timezone explicitly"
        );
    }
}

// ---------------------------------------------------------------------------
// M-19c — chunk-flush rebuild regression suite
// ---------------------------------------------------------------------------
//
// Lives in its own `mod tests` (per-file isolated, see CHUNK_SIZE
// doc-comment) so sibling rebuild slices for `block_tag_refs.rs` and
// `agenda.rs` can append to their own files in parallel without
// touching `cache/tests.rs`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Fresh in-temp-dir SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a repeating block with a `due_date` and `repeat` rule.
    /// `repeat_count = Some(n)` writes the `repeat-count` property.
    async fn insert_repeating_block(
        pool: &SqlitePool,
        id: &str,
        due_date: &str,
        repeat_rule: &str,
        repeat_count: Option<f64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, due_date) \
             VALUES (?, 'content', 'repeating task', ?)",
        )
        .bind(id)
        .bind(due_date)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'repeat', ?)",
        )
        .bind(id)
        .bind(repeat_rule)
        .execute(pool)
        .await
        .unwrap();

        if let Some(count) = repeat_count {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_num) \
                 VALUES (?, 'repeat-count', ?)",
            )
            .bind(id)
            .bind(count)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    async fn count_cache_rows(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projected_agenda_cache")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Forces the chunk-flush boundary in the rebuild path (M-19) by
    /// seeding a fixture that produces exactly `CHUNK_SIZE * 2 + 5`
    /// projections.  Daily-repeat with `due_date = today` produces 365
    /// projections per block (today+1 .. today+365 inclusive); the
    /// trailing block uses `repeat-count = 295` to land the +5 over
    /// two full chunk boundaries.  Asserts the exact post-rebuild row
    /// count so a chunk-boundary off-by-one cannot slip through.
    #[tokio::test]
    async fn rebuild_chunk_flushes_correctly_at_boundary_m19c() {
        let (pool, _dir) = test_pool().await;
        let today = chrono::Local::now().date_naive();
        let due = today.format("%Y-%m-%d").to_string();

        // 54 blocks × 365 + 1 block × repeat-count 295
        //   = 19 710 + 295 = 20 005 = CHUNK_SIZE * 2 + 5.
        // The +5 ensures a third partial flush past two full chunks.
        let expected: i64 = i64::try_from(CHUNK_SIZE * 2 + 5).expect("test fixture size fits i64");

        for i in 0..54 {
            let id = format!("BNDRY{i:03}");
            insert_repeating_block(&pool, &id, &due, "daily", None).await;
        }
        insert_repeating_block(&pool, "BNDRY054", &due, "daily", Some(295.0)).await;

        rebuild_projected_agenda_cache(&pool).await.unwrap();

        let total = count_cache_rows(&pool).await;
        assert_eq!(
            total, expected,
            "every entry must land — chunk boundaries must not lose rows"
        );
    }

    /// Seeds a populated cache, drops every repeating block, runs the
    /// rebuild, and asserts the cache is empty.  Verifies that the
    /// up-front DELETE in the chunk-flush path correctly clears stale
    /// entries when the new desired state is empty.
    #[tokio::test]
    async fn rebuild_with_no_repeating_blocks_clears_cache_m19c() {
        let (pool, _dir) = test_pool().await;
        let today = chrono::Local::now().date_naive();
        let due = today.format("%Y-%m-%d").to_string();

        // Seed: insert a daily-repeating block + run the rebuild so the
        // cache is non-empty before the drop.
        insert_repeating_block(&pool, "CLR001", &due, "daily", None).await;
        rebuild_projected_agenda_cache(&pool).await.unwrap();
        let seeded = count_cache_rows(&pool).await;
        assert!(
            seeded > 0,
            "seed step must populate the cache before drop, got {seeded}"
        );

        // Drop all repeating blocks by removing the `repeat` property
        // (the rebuild's source SELECT requires `bp.value_text IS NOT NULL`).
        sqlx::query("DELETE FROM block_properties WHERE key = 'repeat'")
            .execute(&pool)
            .await
            .unwrap();

        // Rebuild — no repeating blocks ⇒ no projections ⇒ cache empty.
        rebuild_projected_agenda_cache(&pool).await.unwrap();

        let total = count_cache_rows(&pool).await;
        assert_eq!(
            total, 0,
            "rebuild with no repeating blocks must clear the cache, got {total}"
        );
    }

    /// Exercises the M-19 atomicity invariant: a partial chunk-flush
    /// failure must roll back the entire rebuild — including the
    /// up-front DELETE — so the cache reverts to its pre-rebuild
    /// state.  Failure injection is via a `BEFORE INSERT` trigger that
    /// `RAISE(ABORT)`s once the cache reaches 3 rows.  The rebuild's
    /// chunked INSERT inserts row 1, 2, 3 successfully, then the 4th
    /// row's trigger fires, which aborts the multi-row INSERT
    /// statement.  The rebuild propagates the error, the
    /// `Transaction` Drop guard rolls back the implicit `BEGIN`, and
    /// the pre-seeded row survives.
    #[tokio::test]
    async fn rebuild_is_atomic_on_failure_m19c() {
        let (pool, _dir) = test_pool().await;
        let today = chrono::Local::now().date_naive();
        let due = today.format("%Y-%m-%d").to_string();

        // Pre-seed cache state — a single row whose block_id satisfies
        // the FK on `blocks(id)`.  Survival of this row after the
        // failed rebuild is the atomicity assertion.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) \
             VALUES ('PRESEED1', 'content', 'pre-seed')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projected_agenda_cache (block_id, projected_date, source) \
             VALUES ('PRESEED1', '2099-01-01', 'due_date')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Repeating block so the rebuild has work to do.
        insert_repeating_block(&pool, "FAILRPT1", &due, "daily", None).await;

        // Failure injector: raise ABORT once the cache hits 3 rows.
        // `BEFORE INSERT` evaluates the WHEN clause per row; the count
        // is taken from the in-flight transaction's view, which sees
        // the post-DELETE state plus rows committed by prior iterations
        // of the same multi-row INSERT.
        sqlx::query(
            "CREATE TRIGGER fail_after_3_inserts \
             BEFORE INSERT ON projected_agenda_cache \
             WHEN (SELECT COUNT(*) FROM projected_agenda_cache) >= 3 \
             BEGIN \
                SELECT RAISE(ABORT, 'm19c-test-injected-failure'); \
             END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = rebuild_projected_agenda_cache(&pool).await;
        assert!(
            result.is_err(),
            "rebuild must propagate the trigger-injected ABORT"
        );

        // Drop the trigger before inspecting state so the assertion
        // SELECT does not itself fire it (SELECT doesn't fire INSERT
        // triggers, but the cleanup is still hygienic for the test).
        sqlx::query("DROP TRIGGER fail_after_3_inserts")
            .execute(&pool)
            .await
            .unwrap();

        // Atomicity assertion: cache reverted to pre-rebuild state ⇒
        // exactly the seeded row, untouched.
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT block_id, projected_date, source FROM projected_agenda_cache \
             ORDER BY block_id, projected_date, source",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "rolled-back rebuild must preserve pre-seeded cache state"
        );
        assert_eq!(rows[0].0, "PRESEED1");
        assert_eq!(rows[0].1, "2099-01-01");
        assert_eq!(rows[0].2, "due_date");
    }

    /// Full-horizon smoke test for the chunk-flush path (M-19): 50
    /// daily-repeating blocks × 365-day horizon = 18 250 projections,
    /// well over `CHUNK_SIZE = 10 000`.  Asserts every projection
    /// lands and the post-rebuild rows span the expected canonical
    /// `(projected_date, block_id, source)` ordering — first row
    /// dated today+1, last row dated today+365.
    #[tokio::test]
    async fn rebuild_with_full_horizon_completes_under_chunk_flush_m19c() {
        let (pool, _dir) = test_pool().await;
        let today = chrono::Local::now().date_naive();
        let due = today.format("%Y-%m-%d").to_string();

        const N_BLOCKS: usize = 50;
        for i in 0..N_BLOCKS {
            let id = format!("HRZN{i:03}");
            insert_repeating_block(&pool, &id, &due, "daily", None).await;
        }

        rebuild_projected_agenda_cache(&pool).await.unwrap();

        let total = count_cache_rows(&pool).await;
        let expected: i64 = i64::try_from(N_BLOCKS * 365).expect("test fixture size fits i64");
        let chunk_size_i64 =
            i64::try_from(CHUNK_SIZE).expect("CHUNK_SIZE is a const that fits i64");
        assert_eq!(
            total, expected,
            "full-horizon rebuild must land every projection"
        );
        assert!(
            total > chunk_size_i64,
            "test must exercise > 1 chunk boundary; got {total} ≤ CHUNK_SIZE"
        );

        // Canonical order: first row's `projected_date` = today+1, last
        // row's `projected_date` = today+365.  Verifies no entries are
        // dropped at chunk boundaries.
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT block_id, projected_date, source FROM projected_agenda_cache \
             ORDER BY projected_date, block_id, source",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            i64::try_from(rows.len()).expect("test row count fits i64"),
            expected
        );

        let first_date = (today + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let last_date = (today + chrono::Duration::days(365))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(
            rows.first().unwrap().1,
            first_date,
            "first canonical date must be today+1"
        );
        assert_eq!(
            rows.last().unwrap().1,
            last_date,
            "last canonical date must be today+365"
        );
    }
}
