use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// `projected_agenda_cache` has 3 columns per row
/// (block_id, projected_date, source) → `MAX_SQL_PARAMS / 3 = 333` rows
/// per chunked `INSERT OR IGNORE` (M-18). Mirrors the constant naming in
/// `cache/tags.rs` and `cache/pages.rs` for consistency across split-pool
/// rebuilds.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

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

    let entries = compute_projection_entries(today, horizon, &rows);
    let written = entries.len() as u64;

    // Write to DB: DELETE + INSERT in a single transaction.
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;

    // Chunked multi-row INSERT (M-18): 3 columns per row, so each
    // statement binds at most `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`
    // parameters. Replaces the per-row INSERT loop that violated the
    // chunked-INSERT convention from AGENTS.md.
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
        q.execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(written)
}

/// Source-of-truth projection compute step shared by the single-pool and
/// split-pool rebuilds.
///
/// Given a snapshot of repeating-block rows + a `today` reference date and
/// 365-day `horizon`, returns the `(block_id, projected_date, source)`
/// entries the caller will write into `projected_agenda_cache`.  Both
/// rebuild paths must produce **identical** entries for identical inputs;
/// keeping the recurrence logic in one helper removes the risk of the two
/// paths drifting (M-17 invariant #7).
fn compute_projection_entries(
    today: chrono::NaiveDate,
    horizon: chrono::NaiveDate,
    rows: &[CacheRepeatingRow],
) -> Vec<(String, String, String)> {
    let mut entries: Vec<(String, String, String)> = Vec::new(); // (block_id, date, source)

    for block in rows {
        let rule = match &block.repeat_rule {
            Some(r) if !r.is_empty() => r.clone(),
            _ => continue,
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
                    entries.push((
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
                    entries.push((
                        block.id.clone(),
                        current.format("%Y-%m-%d").to_string(),
                        source_name.to_string(),
                    ));
                    projected_count += 1;
                }
            }
        }
    }

    entries
}

/// Read/write split variant of [`rebuild_projected_agenda_cache`] (M-17).
///
/// Reads repeating blocks from `read_pool` inside a snapshot-isolated
/// transaction, materialises them into memory, runs the (potentially
/// substantial — up to 365 projections per block) recurrence compute in
/// Rust with the read tx already dropped, then runs `DELETE FROM
/// projected_agenda_cache` plus chunked `INSERT OR IGNORE` on
/// `write_pool`.  The writer lock is held only for the final write
/// transaction, never across the Rust-side compute.
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks` / `block_properties`.
/// The next rebuild reconciles any churn — cache rebuilds are background,
/// eventually consistent (AGENTS.md "Performance Conventions / Split
/// read/write pool pattern").
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

    // Compute phase — pure-Rust recurrence projection.  Held outside any
    // tx so the writer lock is not blocked while the (potentially up to
    // 365 projections per block) loop runs.
    let entries = compute_projection_entries(today, horizon, &rows);
    let written = entries.len() as u64;

    // Write phase — DELETE + chunked `INSERT OR IGNORE` on `write_pool`,
    // all wrapped in a single transaction.  Mirrors M-18's chunked-INSERT
    // shape so a single statement binds at most
    // `REBUILD_CHUNK * 3 = 999 ≤ MAX_SQL_PARAMS`.
    let mut tx = write_pool.begin().await?;

    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;

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
        q.execute(&mut *tx).await?;
    }

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
