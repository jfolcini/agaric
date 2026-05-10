//! Persistent parity sink — drains the in-memory `ShadowParitySampler`
//! ring buffer into the `merge_parity_log` SQLite table.
//!
//! ## Why this exists
//!
//! The day-1 ring buffer (`ShadowParitySampler`, default cap 1024)
//! holds the last ~30-60 seconds of parity observations in memory.
//! Anything older is silently evicted — useful for a live-tail
//! debug command, useless for the multi-week shadow-mode
//! observation window the readiness checklist needs (item 6).
//!
//! Day-4 lands the persistent path:
//!
//! - [`flush_to_sqlite`] drains the ring and writes every event
//!   into `merge_parity_log`.  Returns the number of rows
//!   inserted.  Empty ring → `Ok(0)`.
//! - [`purge_old`] deletes rows older than a caller-provided
//!   cutoff timestamp.  Default retention is 30 days; the helper
//!   [`default_retention_cutoff_ms`] computes the cutoff from
//!   `SystemTime::now()`.
//!
//! Both functions are async and take a `&SqlitePool`.  Day-4 does
//! NOT wire them into a periodic task — that's day-5 (flush) and
//! day-7+ (purge) work.  The unit tests below exercise both
//! against an in-process migrated SQLite DB so the persistence
//! path is provably correct before the periodic wiring lands.
//!
//! ## Invariant: the sink is feature-gated
//!
//! Compiles only with `feature = "loro-shadow"`.  The default build
//! (and `cargo nextest run -p agaric`) never links this code, so
//! the binary's parity-sink surface is exactly nil unless shadow
//! mode is explicitly enabled.

use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::loro::parity::ShadowParitySampler;

/// Default shadow-mode retention window: 30 days.  Documented in
/// `migrations/0051_pend_09_merge_parity_log.sql` and SPIKE-REPORT.md
/// §6 item 6.  Long enough to span a typical multi-week shadow-mode
/// observation campaign; short enough that the table doesn't grow
/// unbounded on a per-keystroke op rate.
pub const DEFAULT_RETENTION_DAYS: i64 = 30;

/// Rows-per-statement for the multi-row `INSERT INTO merge_parity_log`.
///
/// Each row binds 9 placeholders (op_id, space_id, op_type,
/// diffy_result, loro_result, matched, bucket, created_at,
/// loro_authoritative_at_classify) so a 100-row chunk binds 900
/// placeholders — still below SQLite's compiled-in 999-variable limit
/// (`SQLITE_LIMIT_VARIABLE_NUMBER`, see [`crate::db::MAX_SQL_PARAMS`]).
/// Day-14 added the ninth placeholder; the chunk size stays at 100.
/// Mirrors the [`fts::index`] pattern.
const FLUSH_CHUNK_ROWS: usize = 100;

/// Compute the timestamp (ms-since-Unix-epoch) below which parity
/// events should be purged, given the default 30-day retention.
///
/// Uses `SystemTime::now()`; on the (impossible-in-practice) case
/// where the system clock is before `UNIX_EPOCH`, returns `0` so a
/// purge call is a no-op rather than a panic.
pub fn default_retention_cutoff_ms() -> i64 {
    let now_ms: i64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let window_ms: i64 = DEFAULT_RETENTION_DAYS
        .saturating_mul(24)
        .saturating_mul(60)
        .saturating_mul(60)
        .saturating_mul(1000);
    now_ms.saturating_sub(window_ms)
}

/// Drain the sampler ring and persist every event into
/// `merge_parity_log`.  Returns the number of rows inserted.
///
/// The drain is atomic against the sampler's internal Mutex (see
/// `ShadowParitySampler::drain`); the SQLite write happens in a
/// single `BEGIN`/`COMMIT` so the inserted rows are all visible at
/// once.  Multi-row INSERTs are chunked by [`FLUSH_CHUNK_ROWS`] to
/// stay under SQLite's `SQLITE_LIMIT_VARIABLE_NUMBER`.
///
/// Day-4 does NOT wire a periodic call to this function — invoke
/// it manually from a debug command or from a future day-5
/// background task.  Returns `Ok(0)` immediately on an empty ring
/// (no SQL is emitted).
///
/// `bucket` is left NULL for every flushed row.  Day-6's bucket
/// classifier scans `WHERE bucket IS NULL AND matched = 0` to
/// pick up the freshly-flushed divergent events.
///
/// ## Failure semantics — events lost over duplicate-write
///
/// The drain happens BEFORE `pool.begin()`, so on a mid-flush SQL
/// error the transaction rolls back (sqlx auto-rollback on `tx`
/// drop) but the drained events are already gone from the ring.
/// This is the deliberate trade-off: a transient SQLite failure
/// (lock contention, full disk) loses up to one ring's worth of
/// parity observations, but never produces duplicate rows in the
/// log.  Callers should `tracing::warn!` on the returned `Err` so
/// the loss is observable.
pub async fn flush_to_sqlite(
    pool: &SqlitePool,
    sampler: &ShadowParitySampler,
) -> Result<usize, AppError> {
    let drained = sampler.drain();
    if drained.is_empty() {
        return Ok(0);
    }

    let mut tx = pool.begin().await?;
    let mut total = 0usize;

    for chunk in drained.chunks(FLUSH_CHUNK_ROWS) {
        // QueryBuilder + push_values pattern matches the FTS index
        // multi-row insert.  The SQL text is constructed at runtime
        // so it doesn't participate in the `query!` macro's
        // compile-time cache (`.sqlx/`); that's the right call here
        // because the table is feature-gated and a default build
        // doesn't have it in the schema cache anyway.
        let mut qb: QueryBuilder<'_, Sqlite> = QueryBuilder::new(
            "INSERT INTO merge_parity_log \
             (op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, \
              created_at, loro_authoritative_at_classify) ",
        );
        qb.push_values(chunk, |mut b, ev| {
            b.push_bind(&ev.op_id)
                .push_bind(&ev.space_id)
                .push_bind(&ev.op_type)
                .push_bind(&ev.diffy_result)
                .push_bind(&ev.loro_result)
                .push_bind(if ev.r#match { 1i64 } else { 0i64 })
                // bucket is NULL until the day-6 classifier runs.
                .push_bind::<Option<String>>(None)
                .push_bind(ev.timestamp)
                // Day-14: the cutover-flag value at record time.  See
                // `ParityEvent::loro_authoritative` and migration 0055.
                .push_bind(if ev.loro_authoritative { 1i64 } else { 0i64 });
        });
        qb.build().execute(&mut *tx).await?;
        total += chunk.len();
    }

    tx.commit().await?;
    Ok(total)
}

/// Delete every `merge_parity_log` row with `created_at < before_ts_ms`.
/// Returns the number of rows deleted.
///
/// `before_ts_ms` is a wall-clock cutoff in ms-since-Unix-epoch.
/// Use [`default_retention_cutoff_ms`] for the default 30-day
/// retention window.
///
/// The DELETE is a single statement covered by the
/// `idx_merge_parity_log_created_at` index — for a 30-day retention
/// against typical per-keystroke op rates this stays well under the
/// "use chunked deletes" threshold.  Re-evaluate if the table grows
/// past ~10M rows; chunking with `LIMIT` would need an index on
/// `(created_at, id)` first.
pub async fn purge_old(pool: &SqlitePool, before_ts_ms: i64) -> Result<usize, AppError> {
    let result = sqlx::query("DELETE FROM merge_parity_log WHERE created_at < ?")
        .bind(before_ts_ms)
        .execute(pool)
        .await?;
    Ok(usize::try_from(result.rows_affected()).unwrap_or(usize::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loro::parity::ParityEvent;
    use sqlx::Row;
    use tempfile::TempDir;

    /// Build a fresh migrated SQLite pool in a tempdir.  Mirrors the
    /// `db::tests::test_pool` fixture but lifted here so this module
    /// stays self-contained and the test doesn't need to hop modules
    /// for its DB setup.
    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("parity_sink_test.db");
        let pool = crate::db::init_pool(&db_path)
            .await
            .expect("init_pool should run all migrations");
        (pool, dir)
    }

    fn ev(op_id: &str, op_type: &str, matched: bool, ts_ms: i64) -> ParityEvent {
        ParityEvent {
            op_id: op_id.into(),
            space_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            op_type: op_type.into(),
            diffy_result: format!("diffy:{op_id}"),
            loro_result: format!("loro:{op_id}"),
            r#match: matched,
            timestamp: ts_ms,
            loro_authoritative: false,
        }
    }

    /// Variant of `ev` that lets a test specify the cutover-flag
    /// value the event was recorded under.  Day-14: every parity-sink
    /// row carries this column; the helper makes test rows
    /// declarative without a full struct literal.
    fn ev_with_authoritative(
        op_id: &str,
        op_type: &str,
        matched: bool,
        ts_ms: i64,
        loro_authoritative: bool,
    ) -> ParityEvent {
        ParityEvent {
            op_id: op_id.into(),
            space_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            op_type: op_type.into(),
            diffy_result: format!("diffy:{op_id}"),
            loro_result: format!("loro:{op_id}"),
            r#match: matched,
            timestamp: ts_ms,
            loro_authoritative,
        }
    }

    #[tokio::test]
    async fn flush_to_sqlite_inserts_drained_events() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(16);

        sampler.record(ev("DEV/1", "create_block", true, 1_000));
        sampler.record(ev("DEV/2", "edit_block", false, 2_000));
        sampler.record(ev("DEV/3", "delete_block", true, 3_000));

        let inserted = flush_to_sqlite(&pool, &sampler)
            .await
            .expect("flush should succeed");
        assert_eq!(
            inserted, 3,
            "all three drained events should land in SQLite"
        );

        // Verify the row count.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count query should succeed");
        assert_eq!(count, 3);

        // Verify column fidelity for one row — `DEV/2` is the
        // divergent edit so it covers both the matched=0 path and
        // the op_type / timestamp / summary round-trip.
        let row = sqlx::query(
            "SELECT op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at \
             FROM merge_parity_log WHERE op_id = ?",
        )
        .bind("DEV/2")
        .fetch_one(&pool)
        .await
        .expect("DEV/2 row should exist");

        let op_id: String = row.get("op_id");
        let space_id: String = row.get("space_id");
        let op_type: String = row.get("op_type");
        let diffy_result: String = row.get("diffy_result");
        let loro_result: String = row.get("loro_result");
        let matched: i64 = row.get("matched");
        let bucket: Option<String> = row.get("bucket");
        let created_at: i64 = row.get("created_at");

        assert_eq!(op_id, "DEV/2");
        assert_eq!(space_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(op_type, "edit_block");
        assert_eq!(diffy_result, "diffy:DEV/2");
        assert_eq!(loro_result, "loro:DEV/2");
        assert_eq!(matched, 0, "diverged event must persist as matched = 0");
        assert!(
            bucket.is_none(),
            "bucket must be NULL until day-6 classifier runs"
        );
        assert_eq!(created_at, 2_000);
    }

    #[tokio::test]
    async fn flush_to_sqlite_drains_sampler() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(16);
        sampler.record(ev("DEV/1", "create_block", true, 1));
        sampler.record(ev("DEV/2", "edit_block", true, 2));

        let inserted = flush_to_sqlite(&pool, &sampler).await.expect("flush");
        assert_eq!(inserted, 2);

        // Sampler is empty after the flush — a second flush is a no-op.
        assert!(
            sampler.snapshot().is_empty(),
            "sampler ring must be empty after flush"
        );

        let inserted2 = flush_to_sqlite(&pool, &sampler)
            .await
            .expect("second flush");
        assert_eq!(
            inserted2, 0,
            "second flush against empty ring inserts nothing"
        );

        // DB still holds the original two rows (idempotent against
        // empty drains).
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn flush_to_sqlite_handles_empty_sampler() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(16);

        let inserted = flush_to_sqlite(&pool, &sampler)
            .await
            .expect("empty flush should be Ok(0)");
        assert_eq!(inserted, 0);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn purge_old_deletes_only_old_rows() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(16);

        // Two rows with a clear ordering: one ancient (ts=100), one
        // recent (ts=1_000_000_000).  Cutoff at 1000 must delete only
        // the ancient row.
        sampler.record(ev("OLD", "create_block", true, 100));
        sampler.record(ev("NEW", "create_block", true, 1_000_000_000));
        flush_to_sqlite(&pool, &sampler).await.expect("flush");

        let deleted = purge_old(&pool, 1000).await.expect("purge");
        assert_eq!(deleted, 1, "exactly one ancient row should be deleted");

        let remaining: Vec<String> = sqlx::query_scalar("SELECT op_id FROM merge_parity_log")
            .fetch_all(&pool)
            .await
            .expect("select op_ids");
        assert_eq!(remaining, vec!["NEW".to_string()]);
    }

    #[tokio::test]
    async fn purge_old_returns_count() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(16);

        // Five ancient rows + two recent ones.  Cutoff at 500 deletes
        // exactly the five ancients.
        for seq in 0..5 {
            sampler.record(ev(&format!("OLD/{seq}"), "create_block", true, 100));
        }
        sampler.record(ev("NEW/1", "create_block", true, 1_000));
        sampler.record(ev("NEW/2", "create_block", true, 2_000));
        flush_to_sqlite(&pool, &sampler).await.expect("flush");

        let deleted = purge_old(&pool, 500).await.expect("purge");
        assert_eq!(
            deleted, 5,
            "purge_old must return the count of rows it deleted"
        );

        // Sanity: a second purge with the same cutoff is a no-op.
        let deleted2 = purge_old(&pool, 500).await.expect("second purge");
        assert_eq!(deleted2, 0);

        // The two recent rows survive.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn flush_to_sqlite_handles_multi_chunk_drain() {
        // Exercise the chunking path: drain > FLUSH_CHUNK_ROWS events
        // in one call so the inner `chunks` loop fires more than once.
        // Without this test a regression that broke chunking (e.g.
        // misuse of `chunks` returning a non-exhaustive slice) would
        // pass against a small ring.
        let (pool, _dir) = fresh_pool().await;
        let n = FLUSH_CHUNK_ROWS * 2 + 17; // 217 events
        let sampler = ShadowParitySampler::with_capacity(n);
        for seq in 0..n {
            sampler.record(ev(
                &format!("DEV/{seq}"),
                "create_block",
                seq % 2 == 0,
                i64::try_from(seq).expect("test seq fits in i64"),
            ));
        }

        let inserted = flush_to_sqlite(&pool, &sampler).await.expect("flush");
        assert_eq!(inserted, n);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(usize::try_from(count).expect("test count fits in usize"), n);
    }

    /// Day-14: when an event is recorded with `loro_authoritative = true`
    /// the corresponding `loro_authoritative_at_classify` column is `1`
    /// after flush.  The column lets post-cutover analysis distinguish
    /// shadow-mode-era rows from cutover-era rows without having to
    /// consult `app_settings`.
    #[tokio::test]
    async fn parity_event_records_loro_authoritative_flag_when_true() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(4);

        sampler.record(ev_with_authoritative(
            "DEV/CUT",
            "edit_block",
            true,
            4_000,
            true,
        ));

        let inserted = flush_to_sqlite(&pool, &sampler).await.expect("flush");
        assert_eq!(inserted, 1);

        let value: i64 = sqlx::query_scalar(
            "SELECT loro_authoritative_at_classify FROM merge_parity_log WHERE op_id = ?",
        )
        .bind("DEV/CUT")
        .fetch_one(&pool)
        .await
        .expect("fetch authoritative column");
        assert_eq!(
            value, 1,
            "loro_authoritative=true must persist as 1 in the column",
        );
    }

    /// Day-14: when an event is recorded with `loro_authoritative = false`
    /// (the shadow-mode default) the column persists as `0`.
    #[tokio::test]
    async fn parity_event_records_loro_authoritative_flag_when_false() {
        let (pool, _dir) = fresh_pool().await;
        let sampler = ShadowParitySampler::with_capacity(4);

        // The default `ev(...)` helper sets `loro_authoritative = false`,
        // mirroring shadow-mode `merge::shadow_apply` callers before the
        // flag flips.
        sampler.record(ev("DEV/SHADOW", "edit_block", true, 4_000));

        let inserted = flush_to_sqlite(&pool, &sampler).await.expect("flush");
        assert_eq!(inserted, 1);

        let value: i64 = sqlx::query_scalar(
            "SELECT loro_authoritative_at_classify FROM merge_parity_log WHERE op_id = ?",
        )
        .bind("DEV/SHADOW")
        .fetch_one(&pool)
        .await
        .expect("fetch authoritative column");
        assert_eq!(
            value, 0,
            "loro_authoritative=false must persist as 0 in the column",
        );
    }
}
