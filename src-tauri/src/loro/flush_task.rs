//! Background tokio task that periodically drains the in-memory
//! parity sampler ring into `merge_parity_log`, classifies the
//! freshly-flushed rows into A/B/C/D buckets, and purges rows past
//! the default 30-day retention window.
//!
//! ## Why a separate task (not piggy-backed on the materializer)
//!
//! The materializer's loop is a foreground / background work queue
//! whose tick semantics are tied to per-block cache rebuilds.  The
//! parity sink has a different concern (drain a process-global ring
//! into a single row-append table) and a different cadence
//! (`FLUSH_INTERVAL_SECS = 30 s`, `PURGE_INTERVAL_SECS = 1 h`), so a
//! standalone tokio task — spawned alongside the materializer in
//! `crate::run`'s setup closure — is the cleaner shape.  The task
//! borrows the same shutdown-on-drop pattern as
//! `materializer::retry_queue::spawn_sweeper`: a `tokio::time::interval`
//! that drops with the future when the runtime shuts down.
//!
//! ## Failure handling
//!
//! Both calls (`flush_to_sqlite`, `purge_old`) are wrapped in
//! `if let Err(e) = …` blocks that emit `tracing::warn!` and continue
//! to the next tick.  The task **never** aborts on a SQL error — a
//! transient lock contention or full-disk condition must not silently
//! kill the parity-observation pipeline.  The trade-off is documented
//! on `parity_sink::flush_to_sqlite`: events are drained from the ring
//! before the SQL transaction begins, so a flush failure costs at most
//! one ring's worth of observations (default cap 1024).
//!
//! Per AGENTS.md "Backend Patterns": a routine flush failure is
//! `tracing::warn!`, not `tracing::error!` — the latter is reserved
//! for conditions that need operator attention.

use std::time::Duration;

use sqlx::SqlitePool;

use crate::loro::classifier::classify_unbucketed;
use crate::loro::parity_sink::{default_retention_cutoff_ms, flush_to_sqlite, purge_old};
use crate::loro::shared::ShadowState;

/// Cadence at which the in-memory parity sampler is drained into
/// `merge_parity_log`.  30 s is a balance between bounding loss-on-
/// crash to a single ring (default cap 1024 events) and not hammering
/// the SQLite write pool with empty-drain transactions on idle apps.
pub const FLUSH_INTERVAL_SECS: u64 = 30;

/// Cadence at which `purge_old` is invoked to delete rows past the
/// default 30-day retention window.  1 h is comfortably below the
/// 30-day retention horizon (so the table never grows past
/// `retention + 1 h` of rows in steady state) and far cheaper than
/// a per-flush purge would be.
pub const PURGE_INTERVAL_SECS: u64 = 3_600;

/// PEND-09 Phase 2 day-6 — cadence at which the per-space LoroDoc
/// snapshot scheduler walks the registry and writes every engine's
/// current state into `loro_doc_state` (see migration `0052`).  5
/// minutes is the soft default from `PEND-09-PHASE-2-CUTOVER-PLAN.md`
/// §8.1: short enough that "snapshot on shutdown only" never has more
/// than ~5 minutes of unbacked op-log replay to do on the next boot;
/// long enough that the snapshot's I/O / CPU cost is amortised over
/// hundreds of materializer ticks at typical typing rates.
pub const SNAPSHOT_INTERVAL_SECS: u64 = 300;

/// Run the periodic flush + purge loop.  Never returns under normal
/// operation; cancellable by dropping the spawned future (the inner
/// `tokio::time::interval` drops with it).
///
/// Tick cadence is driven by `flush_interval`; `purge_interval` is
/// implemented by counting elapsed flush ticks rather than a second
/// `tokio::time::interval` so the two cadences cannot drift apart on
/// a heavily-loaded runtime.  The first purge fires after
/// `purge_interval` has elapsed (not on the first tick), matching the
/// "warm up before retention sweeps" pattern used by
/// `materializer::retry_queue::spawn_sweeper`.
pub async fn run_periodic_flush(
    pool: SqlitePool,
    state: &'static ShadowState,
    flush_interval: Duration,
    purge_interval: Duration,
    snapshot_interval: Duration,
) {
    let mut interval = tokio::time::interval(flush_interval);
    // Skip the immediate first tick — `tokio::time::interval` fires
    // once at construction.  We want the first flush after the first
    // real wait so a fast-start app doesn't burn a transaction on a
    // ring that hasn't seen any ops yet.
    interval.tick().await;

    // Purge cadence is in units of flush ticks: how many flushes per
    // purge.  Saturate-up so a misconfigured (purge < flush) caller
    // gets "purge every flush" rather than divide-by-zero.
    let flush_ms = flush_interval.as_millis().max(1);
    let purge_ms = purge_interval.as_millis().max(1);
    let snapshot_ms = snapshot_interval.as_millis().max(1);
    let ticks_per_purge: u128 = purge_ms.div_ceil(flush_ms);
    let ticks_per_snapshot: u128 = snapshot_ms.div_ceil(flush_ms);
    let mut tick_count: u128 = 0;

    loop {
        interval.tick().await;
        tick_count = tick_count.saturating_add(1);

        match flush_to_sqlite(&pool, &state.sampler).await {
            Ok(0) => { /* idle ring, no log spam */ }
            Ok(n) => {
                tracing::debug!(
                    flushed = n,
                    "loro-shadow: parity sink flushed events to SQLite",
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro-shadow: parity flush_to_sqlite failed; continuing",
                );
            }
        }

        // Day-6: classify the freshly-flushed rows on the same tick so
        // a tail-latency dashboard can colour them by bucket without
        // waiting for a separate cadence.  No-op when nothing is
        // pending — see `classify_unbucketed` docs.  We deliberately
        // chose to piggy-back on the flush tick rather than introduce
        // a third interval constant: classification per row is a
        // string-prefix check + an indexed UPDATE, the
        // `WHERE bucket IS NULL` filter makes the empty-pending case
        // a single index probe, and chaining the two cadences avoids
        // a window where flushed-but-unclassified rows accumulate.
        match classify_unbucketed(&pool).await {
            Ok(s) if s.total() == 0 => { /* idle classifier, no log spam */ }
            Ok(s) => {
                tracing::debug!(
                    a = s.a,
                    b = s.b,
                    c = s.c,
                    d = s.d,
                    "loro-shadow: parity classifier filled buckets",
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro-shadow: parity classify_unbucketed failed; continuing",
                );
            }
        }

        if tick_count.is_multiple_of(ticks_per_purge) {
            let cutoff = default_retention_cutoff_ms();
            match purge_old(&pool, cutoff).await {
                Ok(0) => { /* nothing aged out */ }
                Ok(n) => {
                    tracing::debug!(
                        purged = n,
                        cutoff_ms = cutoff,
                        "loro-shadow: parity sink purged stale rows",
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        cutoff_ms = cutoff,
                        "loro-shadow: parity purge_old failed; continuing",
                    );
                }
            }
        }

        // PEND-09 Phase 2 day-6 — periodic per-space snapshot.  Walks
        // the registry and writes every engine's exported snapshot
        // bytes into `loro_doc_state` so the next process boot can
        // rehydrate without replaying the full op-log.  Per-space
        // errors are caught + logged inside `save_all_engines`,
        // mirroring the flush-error pattern: the scheduler MUST NOT
        // crash the app on a transient SQL or Loro export failure.
        if tick_count.is_multiple_of(ticks_per_snapshot) {
            let saved = crate::loro::snapshot::save_all_engines(&pool, &state.registry).await;
            if saved > 0 {
                tracing::debug!(saved, "loro-shadow: per-space LoroDoc snapshots persisted",);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loro::parity::{ParityEvent, ShadowParitySampler};
    use crate::loro::registry::LoroEngineRegistry;
    use crate::loro::shared::ShadowState;
    use sqlx::SqlitePool;
    use std::sync::OnceLock;
    use tempfile::TempDir;

    /// Per-test `ShadowState` static.  The production global lives in
    /// `crate::loro::shared::GLOBAL`; we can't reuse it because the
    /// `&'static ShadowState` parameter mandates a static lifetime
    /// AND the production global would couple every test to the
    /// shared sampler.  Each test allocates its own per-test static
    /// via `Box::leak`, scoped through a `OnceLock` so the leak
    /// happens at most once per test invocation.
    fn leak_state() -> &'static ShadowState {
        // Each call leaks a new state — the per-test process model of
        // `cargo nextest` ensures one state per test process.  Within
        // a single test binary the leak is bounded by the test count.
        Box::leak(Box::new(ShadowState {
            registry: LoroEngineRegistry::new(),
            sampler: ShadowParitySampler::with_capacity(64),
        }))
    }

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("flush_task_test.db");
        let pool = crate::db::init_pool(&db_path)
            .await
            .expect("init_pool migrations");
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

    /// Tiny intervals + a few pushed events: after 100 ms the periodic
    /// task must have flushed all three rows into `merge_parity_log`.
    /// Aborting the JoinHandle drops the interval and ends the task.
    #[tokio::test]
    async fn run_periodic_flush_flushes_events_after_first_tick() {
        let (pool, _dir) = fresh_pool().await;
        let state = leak_state();

        state
            .sampler
            .record(ev("DEV/1", "create_block", true, 1_000));
        state
            .sampler
            .record(ev("DEV/2", "edit_block", false, 2_000));
        state
            .sampler
            .record(ev("DEV/3", "delete_block", true, 3_000));

        let pool_for_task = pool.clone();
        let handle = tokio::spawn(async move {
            run_periodic_flush(
                pool_for_task,
                state,
                Duration::from_millis(20),
                // 1 s purge interval — well above the 100 ms sleep so
                // this test never invokes purge_old.
                Duration::from_secs(1),
                // 1 s snapshot interval — same reasoning.
                Duration::from_secs(1),
            )
            .await;
        });

        // Skip the first tick (skipped by the task) plus a couple of
        // real flushes — 100 ms over a 20 ms cadence is ~5 ticks.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 3, "all three pushed events must be flushed");

        // Sampler ring must be empty (drained by the task).
        assert!(
            state.sampler.snapshot().is_empty(),
            "ring buffer must be empty after the task drained it"
        );

        handle.abort();
    }

    /// Provoke a flush error by closing the pool partway through, then
    /// verify the task is still alive (still ticking) afterwards.
    /// Closing a `SqlitePool` causes subsequent queries to return
    /// `PoolClosed`, exercising the `Err` arm of `flush_to_sqlite`.
    #[tokio::test]
    async fn run_periodic_flush_continues_after_flush_error() {
        let (pool, _dir) = fresh_pool().await;
        let state = leak_state();

        // Push one event so the first flush is non-empty (and produces
        // a real INSERT against the soon-to-be-closed pool).
        state.sampler.record(ev("DEV/1", "create_block", true, 1));

        let pool_for_task = pool.clone();
        let handle = tokio::spawn(async move {
            run_periodic_flush(
                pool_for_task,
                state,
                Duration::from_millis(20),
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .await;
        });

        // Wait for at least one flush so we know the task is running.
        tokio::time::sleep(Duration::from_millis(60)).await;

        // Close the pool — every subsequent query the task issues will
        // return `Error::PoolClosed`, hitting the `Err` arm.  We hold
        // a clone in `pool` so observations after the close still
        // route through the closed connection state.
        pool.close().await;

        // Push another event so the next flush attempt is non-empty
        // (an empty drain returns `Ok(0)` without ever touching the
        // pool, which would NOT exercise the error path).
        state.sampler.record(ev("DEV/2", "create_block", false, 2));

        // Several flush ticks against the closed pool — task must NOT
        // panic / abort.  `is_finished` is the canonical "did the
        // future return?" check on a JoinHandle.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !handle.is_finished(),
            "task must keep running after a flush error",
        );

        handle.abort();
    }

    /// Pre-populate the table with rows older than the 30-day cutoff,
    /// then run with a fast purge cadence and verify the old rows are
    /// deleted while a fresh row survives.  This exercises the
    /// `purge_old` branch of the periodic loop using the real
    /// `default_retention_cutoff_ms()` cutoff (i.e. the production
    /// retention window, not a synthetic one).
    #[tokio::test]
    async fn run_periodic_flush_invokes_purge_at_purge_interval() {
        let (pool, _dir) = fresh_pool().await;
        let state = leak_state();

        // 31-day-old timestamp — guaranteed below
        // `default_retention_cutoff_ms()`.  Insert directly so we can
        // backdate `created_at` past the 30-day retention.
        let now_ms = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time after epoch")
                .as_millis(),
        )
        .expect("now_ms fits in i64");
        let day_ms: i64 = 24 * 60 * 60 * 1000;
        let ancient_ts = now_ms - 31 * day_ms;
        let recent_ts = now_ms;

        for (op_id, ts) in [("OLD/1", ancient_ts), ("OLD/2", ancient_ts)] {
            sqlx::query(
                "INSERT INTO merge_parity_log \
                 (op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
            )
            .bind(op_id)
            .bind("01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .bind("create_block")
            .bind("diffy")
            .bind("loro")
            .bind(1i64)
            .bind(ts)
            .execute(&pool)
            .await
            .expect("seed ancient row");
        }
        sqlx::query(
            "INSERT INTO merge_parity_log \
             (op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .bind("NEW/1")
        .bind("01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .bind("create_block")
        .bind("diffy")
        .bind("loro")
        .bind(1i64)
        .bind(recent_ts)
        .execute(&pool)
        .await
        .expect("seed recent row");

        let initial: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM merge_parity_log")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(initial, 3, "test seeds 2 ancient + 1 recent rows");

        let pool_for_task = pool.clone();
        let handle = tokio::spawn(async move {
            run_periodic_flush(
                pool_for_task,
                state,
                // Flush every 10 ms — purge fires every other tick.
                Duration::from_millis(10),
                Duration::from_millis(20),
                // Snapshot interval kept large so this test exercises
                // the purge branch without the snapshot scheduler
                // racing.
                Duration::from_secs(60),
            )
            .await;
        });

        // 60 ms = ~6 flush ticks = ~3 purge invocations; well above the
        // first-purge boundary regardless of scheduler jitter.
        tokio::time::sleep(Duration::from_millis(60)).await;

        let remaining: Vec<String> = sqlx::query_scalar("SELECT op_id FROM merge_parity_log")
            .fetch_all(&pool)
            .await
            .expect("select op_ids");
        assert_eq!(
            remaining,
            vec!["NEW/1".to_string()],
            "only the recent row must survive the purge",
        );

        handle.abort();
    }

    /// PEND-09 Phase 2 day-6 — fast snapshot cadence.  Pre-populate the
    /// registry with one engine, run with a tiny snapshot interval,
    /// verify a row appears in `loro_doc_state`.
    #[tokio::test]
    async fn run_periodic_flush_invokes_snapshot_scheduler() {
        use crate::loro::engine::LoroEngine;
        use crate::space::SpaceId;

        let (pool, _dir) = fresh_pool().await;
        let state = leak_state();

        // Seed the registry with one engine that has measurable state.
        let space = SpaceId::from_trusted("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        {
            let mut g = state
                .registry
                .for_space(&space, "device-1")
                .expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK1", "content", "snapshot me", None, 0)
                .expect("create");
        }

        let pool_for_task = pool.clone();
        let handle = tokio::spawn(async move {
            run_periodic_flush(
                pool_for_task,
                state,
                Duration::from_millis(10),
                // Purge interval kept large so this test only exercises
                // the snapshot branch.
                Duration::from_secs(60),
                // Snapshot every 20 ms — fires multiple times within
                // the 100 ms sleep below.
                Duration::from_millis(20),
            )
            .await;
        });

        tokio::time::sleep(Duration::from_millis(100)).await;

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state WHERE space_id = ?")
                .bind(space.as_str())
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(
            count, 1,
            "snapshot scheduler must persist a row for the seeded space"
        );

        // The persisted bytes must rehydrate into an engine with the
        // same block visible (round-trip sanity).
        let bytes: Vec<u8> =
            sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                .bind(space.as_str())
                .fetch_one(&pool)
                .await
                .expect("snapshot bytes");
        let mut hydrated = LoroEngine::with_peer_id("device-1").expect("hydrated");
        hydrated.import(&bytes).expect("import");
        let snap = hydrated
            .read_block("BLOCK1")
            .expect("read")
            .expect("present");
        assert_eq!(snap.content, "snapshot me");

        handle.abort();
    }

    /// Suppress unused-import warning when the test module is compiled
    /// without any of the static-leak helpers being touched (paranoid
    /// guard against future refactors).
    #[allow(dead_code)]
    fn _ensure_oncelock_in_scope() -> OnceLock<()> {
        OnceLock::new()
    }
}
