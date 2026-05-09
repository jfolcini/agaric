//! PEND-09 Phase 2 day-9 — the `pend09.loro_authoritative` cutover toggle.
//!
//! ## Why this module exists
//!
//! The Phase-2 cutover plan
//! (`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §3 day 9 + §5) calls for a
//! single runtime flag that, when ON, makes the materializer treat the
//! per-space [`crate::loro::engine::LoroEngine`] as authoritative and
//! projects from it into SQL.  When OFF the existing diffy-merge path
//! remains authoritative.
//!
//! ## Storage + cache
//!
//! - **Storage:** a single row in the `app_settings` STRICT table (key
//!   `pend09.loro_authoritative`, value `'0'` or `'1'`).  Created and
//!   seeded with `'0'` by migration
//!   `0053_pend_09_app_settings.sql`.
//! - **Cache:** a process-global `OnceLock<AtomicBool>` populated by
//!   [`init_cutover_flag`] at app boot.  The materializer hot-path read
//!   ([`is_loro_authoritative`]) is a single
//!   `AtomicBool::load(Ordering::Relaxed)` on a hit — well under the
//!   100 µs target the cutover plan §5.2 sets.
//! - **Refresh:** [`set_loro_authoritative`] updates both the row AND
//!   the cache.  The plan §5.2 also calls for a 30-second refresh on
//!   the flush task tick so a SQL `UPDATE app_settings ...` flips
//!   without a process restart; that wiring is **not** part of day 9 —
//!   the day-9 commit lands the flag infrastructure only.  The
//!   first-class flip path today is `set_loro_authoritative`; the
//!   flush-tick refresh is a follow-up day.
//!
//! ## Default-off invariant
//!
//! Phase-2 day-9 cannot change observable behaviour.  Every call site
//! that branches on the flag MUST default-off when the cache is
//! uninitialised.  [`is_loro_authoritative`] returns `false` on a cache
//! miss (no `unwrap_or(true)` slip-up will land here).  The migration
//! seeds `'0'`; until the maintainer runs `set_loro_authoritative(true)`
//! in Phase-2 day-11+, every read returns `false`.
//!
//! ## Test surface
//!
//! - [`install_cutover_flag_for_test`] (`cfg(test)`-gated) — drops the
//!   `OnceLock` invariant inside test-only code so a single test
//!   binary can flip the cache without restarting the process.  The
//!   `OnceLock` itself is process-global (per
//!   `cargo nextest`'s per-test-process model the global is fresh per
//!   test process), so production builds remain tamper-proof.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use sqlx::SqlitePool;

use crate::error::AppError;

/// The settings key the toggle is stored under.  Public-ish (only via
/// this module) so tests + future maintenance code can refer to it
/// without re-typing the string.
pub const KEY_LORO_AUTHORITATIVE: &str = "pend09.loro_authoritative";

/// Process-global cache.  `None` until [`init_cutover_flag`] runs.
/// `Some(AtomicBool)` thereafter; the inner bool is mutated in place by
/// [`set_loro_authoritative`] (no second `OnceLock::set` ever fires).
static CACHE: OnceLock<AtomicBool> = OnceLock::new();

/// Read the cutover toggle.  Sub-100 µs by construction:
/// - On a hit, a single `AtomicBool::load(Ordering::Relaxed)`
///   (~1 ns on modern x86_64).
/// - On a miss (cache uninitialised), returns `false` — the
///   default-off invariant.  Boot races (a materializer apply landing
///   before [`init_cutover_flag`] returns) thus see "diffy
///   authoritative", which is the correct fallback.
///
/// `Ordering::Relaxed` is sufficient: there is no other state we need
/// to synchronise with the bool.  The store side
/// ([`set_loro_authoritative`]) uses `Ordering::Relaxed` to match.
#[inline]
pub fn is_loro_authoritative() -> bool {
    match CACHE.get() {
        Some(b) => b.load(Ordering::Relaxed),
        None => false,
    }
}

/// Read the row from `app_settings` and populate the cache.  Called
/// from `crate::run`'s setup closure synchronously (via
/// `tauri::async_runtime::block_on`) BEFORE the materializer is
/// available to dispatch ops, so the cutover flag is decisive on the
/// very first op.
///
/// Idempotent: a second call is a no-op (the `OnceLock::set` fails
/// silently and we update the existing AtomicBool's value to match the
/// row).  Errors are propagated — the boot setup closure decides
/// whether to abort or continue with default-off.
///
/// ## Why eager (not lazy / first-read)
///
/// The plan §5.2 mandates sub-100 µs reads on the materializer hot
/// path.  A lazy first-read would spawn an async DB query inside the
/// hot path; even with a connection-pool fast path, that's
/// multi-microsecond and async-aware.  Eager init at boot keeps the
/// hot-path read straight-line atomic.
pub async fn init_cutover_flag(pool: &SqlitePool) -> Result<(), AppError> {
    let row: Option<(String,)> =
        sqlx::query_as::<_, (String,)>("SELECT value FROM app_settings WHERE key = ?")
            .bind(KEY_LORO_AUTHORITATIVE)
            .fetch_optional(pool)
            .await?;

    // The migration seeds `'0'` so the row should exist.  If it
    // doesn't (someone hand-wiped the table, partial migration, …) we
    // fall back to default-off rather than failing boot.
    let value = match row {
        Some((s,)) => s == "1",
        None => {
            tracing::warn!(
                key = KEY_LORO_AUTHORITATIVE,
                "cutover flag row absent from app_settings; defaulting to off",
            );
            false
        }
    };

    // First call: install.  Subsequent calls (e.g. test re-init):
    // mutate the existing bool in place.
    match CACHE.set(AtomicBool::new(value)) {
        Ok(()) => {}
        Err(_already_set) => {
            // Update the existing cell so re-init reflects the row.
            if let Some(b) = CACHE.get() {
                b.store(value, Ordering::Relaxed);
            }
        }
    }

    tracing::info!(
        loro_authoritative = value,
        "cutover flag initialised from app_settings",
    );
    Ok(())
}

/// Update both the `app_settings` row AND the in-process cache.
/// Used by:
/// - Future `agaric debug set-cutover` bin (out of scope for day 9).
/// - Tests that need the flag in a particular state.
/// - The eventual cutover-soak ramp-up (Phase-2 day-11+).
///
/// Both updates happen — if the DB write fails, the cache is left
/// untouched and the error propagates.  If the DB write succeeds, the
/// cache is updated unconditionally (a panicking `OnceLock::set` here
/// would leave the cache stale; we use `store` on the existing cell
/// instead).
pub async fn set_loro_authoritative(pool: &SqlitePool, value: bool) -> Result<(), AppError> {
    let value_str = if value { "1" } else { "0" };
    let now_ms = chrono::Utc::now().timestamp_millis();

    // UPSERT-style — the migration seeds the row, but a defensive
    // INSERT-OR-REPLACE keeps this resilient against future
    // hand-edits.  Single-row update, no concurrency concern (settings
    // writes are maintainer-driven, not on the hot path).
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) \
         VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(KEY_LORO_AUTHORITATIVE)
    .bind(value_str)
    .bind(now_ms)
    .execute(pool)
    .await?;

    // Cache update: install if first time, otherwise store.
    match CACHE.set(AtomicBool::new(value)) {
        Ok(()) => {}
        Err(_already_set) => {
            if let Some(b) = CACHE.get() {
                b.store(value, Ordering::Relaxed);
            }
        }
    }

    tracing::info!(
        loro_authoritative = value,
        "cutover flag updated (row + cache)",
    );
    Ok(())
}

/// Test-only shim — install or overwrite the cache value without
/// touching the DB.  Mirrors [`crate::loro::shared::install_for_test`].
/// Each `cargo nextest` test runs in its own process so the global is
/// fresh; within a single test binary, multiple tests sharing the
/// install is fine because flag-flipping tests live in feature-gated
/// modules that are aware of each other.
#[cfg(test)]
pub fn install_cutover_flag_for_test(value: bool) {
    match CACHE.set(AtomicBool::new(value)) {
        Ok(()) => {}
        Err(_already_set) => {
            if let Some(b) = CACHE.get() {
                b.store(value, Ordering::Relaxed);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::TempDir;

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("cutover_test.db");
        let pool = crate::db::init_pool(&db_path)
            .await
            .expect("init_pool migrations");
        (pool, dir)
    }

    /// Cache-uninit safety: with no install + no init, reads return
    /// `false` (default-off).  Cannot be exercised reliably here
    /// because other tests in this binary install the cache, so the
    /// invariant is enforced by code review + the explicit
    /// `None => false` arm of [`is_loro_authoritative`].  The test
    /// here installs `false` and verifies the read shape.
    #[test]
    fn is_loro_authoritative_default_is_false() {
        // Install false (matching the "uninit returns false" contract
        // — explicit default that any future re-orderer would tamper
        // with by accident).
        install_cutover_flag_for_test(false);
        assert!(!is_loro_authoritative());
    }

    #[tokio::test]
    async fn init_cutover_flag_loads_seeded_value() {
        let (pool, _dir) = fresh_pool().await;
        // Migration seeds `'0'` — init must read `false`.
        init_cutover_flag(&pool).await.expect("init");
        assert!(
            !is_loro_authoritative(),
            "fresh DB seeded '0' must read false",
        );
    }

    #[tokio::test]
    async fn set_loro_authoritative_updates_row_and_cache() {
        let (pool, _dir) = fresh_pool().await;
        init_cutover_flag(&pool).await.expect("init");
        assert!(!is_loro_authoritative(), "starts false");

        set_loro_authoritative(&pool, true).await.expect("set true");
        assert!(is_loro_authoritative(), "cache updated to true");

        // Verify the row.
        let row: (String,) = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
            .bind(KEY_LORO_AUTHORITATIVE)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, "1", "row reflects new value");

        // Flip back.
        set_loro_authoritative(&pool, false)
            .await
            .expect("set false");
        assert!(!is_loro_authoritative(), "cache updated to false");
        let row: (String,) = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
            .bind(KEY_LORO_AUTHORITATIVE)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, "0");
    }

    /// Verify the cache read is sub-100 µs averaged across many
    /// iterations.  Target per the cutover plan §5.2 is ≤1 µs cached;
    /// this test asserts the much-weaker 100 µs ceiling so it stays
    /// non-flaky on slow CI hardware.  An `AtomicBool::load(Relaxed)`
    /// on x86_64 is on the order of 1 ns — three orders of magnitude
    /// of headroom against this assertion.
    #[test]
    fn cache_read_is_sub_100_microseconds() {
        install_cutover_flag_for_test(false);

        const ITERS: u32 = 1_000;
        let start = Instant::now();
        let mut acc: u32 = 0;
        for _ in 0..ITERS {
            // `acc` keeps the read from being optimised out.
            if is_loro_authoritative() {
                acc = acc.wrapping_add(1);
            } else {
                acc = acc.wrapping_add(2);
            }
        }
        let elapsed = start.elapsed();
        let per_call_ns = elapsed.as_nanos() / u128::from(ITERS);
        // 100 µs == 100_000 ns.  Use this huge ceiling so the test is
        // robust on every machine; assert the order-of-magnitude
        // contract not the exact figure.
        assert!(
            per_call_ns < 100_000,
            "is_loro_authoritative() read averaged {per_call_ns} ns per call, \
             must be < 100_000 ns (100 µs) per the cutover plan §5.2",
        );
        // Sanity: the side-effect accumulator was used.
        assert!(acc > 0);
    }
}
