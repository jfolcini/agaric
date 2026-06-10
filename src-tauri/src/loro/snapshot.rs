//! Per-space LoroDoc snapshot persistence.
//!
//! ## Why this exists
//!
//! [`LoroEngineRegistry`] is a process-local
//! `HashMap<SpaceId, LoroEngine>` that is rebuilt from scratch on
//! every process restart — engines are instantiated lazily on first
//! hit and the `LoroDoc` only contains state derived from ops applied
//! during the current process lifetime. The engine is authoritative:
//! the materializer projects from `LoroDoc` state into SQL. A
//! cold-start engine would project an empty doc on top of existing
//! SQL state, corrupting the user's workspace. We persist per-space
//! `LoroDoc` snapshots in a `loro_doc_state` SQLite table, rehydrate
//! on app boot, and periodically re-snapshot in the background.
//!
//! ## Surface
//!
//! - [`save_snapshot`] — exports the engine's current state via
//!   [`LoroEngine::export_snapshot`] and writes it to `loro_doc_state`
//!   under the supplied `space_id`.  Idempotent; an existing row is
//!   replaced (`INSERT OR REPLACE`).
//! - [`load_snapshot`] — reads back the bytes for a given `space_id`,
//!   returning `Ok(None)` if no row exists.
//! - [`load_all_space_snapshots`] — enumerate every persisted
//!   `(space_id, snapshot)` pair.  Used by the eager-load boot pass
//!   that rehydrates the registry without any synchronous-async glue
//!   in `LoroEngineRegistry::for_space` (see decision note below).
//! - [`save_all_engines`] — walk the registry, call [`save_snapshot`]
//!   per space.  Catches and logs per-space errors so one bad space
//!   never blocks the others.  Used by the periodic scheduler.
//!
//! ## Boot rehydration design
//!
//! The plan offered three options for getting a snapshot into the
//! registry on first touch:
//!
//! - (a) Make `for_space` async + thread `&SqlitePool` through.
//!   Invasive — every caller of `merge::engine_apply` would need to
//!   become async.
//! - (b) `tokio::task::block_in_place` + `Handle::block_on` inside the
//!   sync `for_space`.  Hacky and risks deadlocks on single-threaded
//!   runtimes / nested tokio contexts.
//! - (c) Eager-load every persisted snapshot during app boot, into the
//!   registry, before any op-apply runs.  Pure-async path, no
//!   sync-from-async glue, and the boot cost is bounded by the number
//!   of spaces × snapshot-size.
//!
//! **Decision: option (c).**  Boot already has an async context
//! (`tauri::async_runtime::spawn` is invoked from the setup closure
//! around `lib.rs` line ~965), the snapshot table is small (one row
//! per space), and `LoroEngineRegistry` already exposes
//! [`LoroEngineRegistry::install_engine`] (added day-6) for the caller
//! to seed pre-built engines.  `for_space` stays sync and merely pulls
//! from the now-populated registry; on a space whose snapshot has not
//! been persisted yet the lazy-instantiate path still creates a fresh
//! engine, exactly as before.
//!
//! ## Failure semantics
//!
//! `save_snapshot` and `load_snapshot` return `Result<_, AppError>`.
//! The periodic scheduler ([`save_all_engines`]) is the place that
//! must NEVER abort the process: it catches per-space errors and
//! logs `tracing::warn!`, mirroring the
//! `flush_task::run_periodic_flush` failure pattern.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::loro::engine::LoroEngine;
use crate::loro::registry::LoroEngineRegistry;
use crate::space::SpaceId;

/// Wall-clock ms-since-Unix-epoch.  Returns `0` on the
/// (impossible-in-practice) case where the system clock is before
/// `UNIX_EPOCH`, matching `parity_sink::default_retention_cutoff_ms`'s
/// fail-soft convention.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The apply-cursor seq a snapshot taken *now* is guaranteed to reflect
/// (PEND-70 C1/C2 watermark).
///
/// `materializer_apply_cursor.materialized_through_seq` advances in the
/// same tx as the SQL projection, but the per-space `LoroEngine` dispatch
/// runs *after* that commit (see `materializer::apply_op`), so an engine
/// can lag the committed cursor by the single in-flight op. The foreground
/// apply queue is serial, so every op `<= cursor - 1` has finished its
/// engine dispatch. `cursor - 1` (clamped at 0) is therefore a safe lower
/// bound on what every engine reflects; boot replay re-applies the small
/// idempotent tail above it. A read error degrades to `0` (a conservative
/// full rebuild next boot) rather than risking a watermark that overshoots
/// the engine state.
async fn snapshot_watermark(pool: &SqlitePool) -> i64 {
    let cursor: i64 = sqlx::query_scalar!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    (cursor - 1).max(0)
}

/// Persist the engine's current snapshot to `loro_doc_state`.
///
/// Replaces any existing row for `space_id` (`INSERT OR REPLACE`).
/// `op_count` resets to 0 on every save — the column is reserved for
/// a future "snapshot every N ops" cadence and is currently unused by
/// the time-driven scheduler. `applied_through_seq` records the apply
/// cursor the blob reflects (see [`snapshot_watermark`]) so boot can
/// detect a stale snapshot.
pub async fn save_snapshot(
    pool: &SqlitePool,
    space_id: &SpaceId,
    engine: &LoroEngine,
) -> Result<(), AppError> {
    let bytes = engine.export_snapshot()?;
    let updated_at = now_ms();
    let applied_through_seq = snapshot_watermark(pool).await;
    sqlx::query(
        "INSERT OR REPLACE INTO loro_doc_state \
         (space_id, snapshot, updated_at, op_count, applied_through_seq) \
         VALUES (?, ?, ?, 0, ?)",
    )
    .bind(space_id.as_str())
    .bind(bytes)
    .bind(updated_at)
    .bind(applied_through_seq)
    .execute(pool)
    .await?;
    Ok(())
}

/// Load the persisted snapshot bytes for `space_id`, or `Ok(None)` if
/// no row exists.  The bytes are opaque to this layer — the caller
/// passes them to [`LoroEngine::import`] to apply.
pub async fn load_snapshot(
    pool: &SqlitePool,
    space_id: &SpaceId,
) -> Result<Option<Vec<u8>>, AppError> {
    let row: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
            .bind(space_id.as_str())
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(b,)| b))
}

/// Enumerate every persisted snapshot.  Returns `(space_id_string,
/// snapshot_bytes)` pairs — the caller decides what to do with each
/// (usually: `LoroEngine::with_peer_id` + `import` + register).
///
/// This is the single SELECT used by the boot rehydration pass.  Bounded
/// by the user's space count (typically O(10)) so a full table scan
/// is fine.
pub async fn load_all_space_snapshots(
    pool: &SqlitePool,
) -> Result<Vec<(String, Vec<u8>)>, AppError> {
    let rows: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT space_id, snapshot FROM loro_doc_state")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Boot-time rehydration: load every persisted snapshot and seed the
/// registry with pre-built engines.  Called once during app setup
/// before any op-apply runs.  Errors per space are logged + continued
/// — a single corrupt snapshot never blocks the rest of the workspace.
///
/// Returns the number of engines successfully rehydrated.
pub async fn rehydrate_registry(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
) -> usize {
    let rows = match load_all_space_snapshots(pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "loro:rehydrate_registry: load_all_space_snapshots failed; \
                 starting with empty registry",
            );
            return 0;
        }
    };

    let mut ok = 0usize;
    for (space_id_str, bytes) in rows {
        let space_id = SpaceId::from_trusted(&space_id_str);
        let mut engine = match LoroEngine::with_peer_id(device_id) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id_str,
                    error = %e,
                    "loro:rehydrate_registry: with_peer_id failed; skipping space",
                );
                continue;
            }
        };
        if let Err(e) = engine.import(&bytes) {
            tracing::warn!(
                space_id = %space_id_str,
                error = %e,
                "loro:rehydrate_registry: import failed; skipping space",
            );
            continue;
        }
        registry.install_engine(space_id, engine);
        ok += 1;
    }
    ok
}

/// In-process engine reload after a snapshot RESET (#607 / #779).
///
/// `snapshot::apply_snapshot` replaces every core SQL table and wipes the
/// Loro sidecar state (`loro_doc_state`, `loro_sync_inbox`, the apply
/// cursor) in one transaction — but it has no access to the live engine
/// registry, so the in-memory engines still hold the pre-reset CRDT
/// lineage when it returns. Left alone, the next `prepare_outgoing` would
/// export that stale state to peers and the next periodic / exit-time
/// `save_all_engines` would persist it straight back into the freshly
/// wiped `loro_doc_state` (#779's restart scenario).
///
/// This is the matching reload primitive: drop every engine, then re-run
/// the standard boot rehydration against whatever `loro_doc_state` now
/// holds. After a RESET that table is empty, so the registry ends up
/// empty — which is the CORRECT post-reset state, not a shortcut: the
/// snapshot format carries SQL rows only (no CRDT history), and seeding
/// fresh Loro docs from snapshot SQL would mint an independent history
/// whose tree nodes would duplicate the peer's on the next loro-sync
/// merge. An empty engine instead has an empty version vector, so the
/// next sync session imports the peer's full CRDT state cleanly and
/// re-converges engine and SQL.
///
/// Must be called immediately after `apply_snapshot` returns, before any
/// further engine access (the production caller is
/// `sync_daemon::snapshot_transfer::try_receive_snapshot_catchup`).
/// Returns the number of engines rehydrated (0 after a RESET).
pub async fn reload_registry_from_db(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
) -> usize {
    registry.clear();
    rehydrate_registry(pool, registry, device_id).await
}

/// Walk the registry and persist every engine's current snapshot.  Used
/// by the periodic scheduler.  Per-space errors are logged + continued
/// so one bad space never blocks the rest.
///
/// Returns the number of spaces successfully snapshotted.
pub async fn save_all_engines(pool: &SqlitePool, registry: &LoroEngineRegistry) -> usize {
    // Issue #153 — `snapshot_all_engines` collects an O(1) `LoroDoc`
    // *handle* per space under the registry mutex, drops the lock, then
    // runs each (comparatively slow) snapshot export with the lock
    // released. The mutex therefore serialises every engine apply only
    // for the O(spaces) handle-clone pass, not for the O(spaces x export)
    // serialization. A `LoroDoc` clone is a reference clone (shared
    // underlying doc), so this does NOT double peak memory — see
    // `LoroEngineRegistry::snapshot_all_engines` for the full rationale.
    // PEND-70 C1/C2: read the watermark BEFORE acquiring the engine lock,
    // so it is a safe lower bound for every engine exported in this pass —
    // the lock-time cursor can only be >= this value, and each engine
    // reflects all ops <= (lock-time cursor - 1) >= this watermark.
    let applied_through_seq = snapshot_watermark(pool).await;
    // #607 review: capture the clear-generation BEFORE collecting doc
    // handles. A snapshot RESET (`registry.clear()` +
    // `apply_snapshot`'s `loro_doc_state` wipe) racing this pass would
    // otherwise let us persist PRE-reset engine state into the freshly
    // wiped table — the exact #779 resurrection this save exists to
    // prevent. Re-checked before every write below.
    let generation = registry.generation();
    let pairs = registry.snapshot_all_engines();

    let mut ok = 0usize;
    for (space_id, bytes_result) in pairs {
        if registry.generation() != generation {
            tracing::warn!(
                space_id = %space_id,
                "loro:save_all_engines: registry cleared mid-save (snapshot \
                 RESET, #607); aborting — these handles predate the reset \
                 and must not be persisted over the wiped loro_doc_state",
            );
            return ok;
        }
        let bytes = match bytes_result {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id,
                    error = %e,
                    "loro:save_all_engines: export_snapshot failed; skipping space",
                );
                continue;
            }
        };
        let updated_at = now_ms();
        let res = sqlx::query(
            "INSERT OR REPLACE INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) \
             VALUES (?, ?, ?, 0, ?)",
        )
        .bind(space_id.as_str())
        .bind(bytes)
        .bind(updated_at)
        .bind(applied_through_seq)
        .execute(pool)
        .await;
        match res {
            Ok(_) => ok += 1,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id,
                    error = %e,
                    "loro:save_all_engines: INSERT OR REPLACE failed; skipping space",
                );
            }
        }
    }
    // Issue #157 sub-item I — reset the dirty-engines proxy
    // counter so subsequent `loro_snapshot_if_dirty` ticks observe
    // "clean" until the next `for_space` call. Reset on success-or-
    // skip is correct: a per-space failure path above doesn't leave
    // the engine in a state that needs re-snapshotting (the prior
    // snapshot is still valid; only THAT engine's incremental delta
    // is missing, which the next mutation will mark dirty again
    // through `for_space`).
    registry.clear_dirty();
    ok
}

/// Default cadence for the periodic snapshot task (5 minutes).
///
/// Restored after the PEND-09 parity flush task — which hosted the
/// `save_all_engines` call on its tick — was deleted, leaving snapshots
/// unpersisted (the resulting empty `loro_doc_state` + advancing apply
/// cursor wedged the materializer). The engine applies at human-typing
/// rates, so a 5-minute snapshot bounds the boot-replay tail to a
/// handful of ops while keeping the snapshot cost negligible.
pub const SNAPSHOT_INTERVAL_SECS: u64 = 300;

/// Spawn the periodic Loro snapshot task.
///
/// Every `interval_secs` it walks the process-global engine registry and
/// persists each engine's snapshot into `loro_doc_state`, so the next
/// boot rehydrates without replaying the full op-log. The task runs for
/// the app's lifetime and stops once `shutdown` flips. Per-space errors
/// are caught + logged inside [`save_all_engines`], so a transient
/// SQL/Loro failure never crashes the app.
pub fn spawn_periodic_snapshot(
    pool: SqlitePool,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    interval_secs: u64,
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    #[cfg(not(test))]
    let spawn_fn = tauri::async_runtime::spawn;
    #[cfg(test)]
    let spawn_fn = tokio::spawn;

    // Fire-and-forget: the task lives for the process lifetime and stops
    // when `shutdown` flips. The JoinHandle is intentionally discarded.
    let _handle = spawn_fn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs.max(1)));
        // Skip the immediate first tick — `tokio::time::interval` fires
        // once at construction. Boot rehydrate just ran, so there is
        // nothing new to persist yet.
        interval.tick().await;
        loop {
            interval.tick().await;
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            let Some(state) = crate::loro::shared::get() else {
                continue;
            };
            let saved = save_all_engines(&pool, &state.registry).await;
            if saved > 0 {
                tracing::debug!(spaces = saved, "loro: periodic snapshot persisted");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    /// Distinct space for the periodic-snapshot smoke test. The global
    /// registry is shared within a test binary, so this ULID must not
    /// collide with `SPACE_A`/`SPACE_B` above.
    const SPACE_PERIODIC: &str = "01J0PERIODICSNAP000000TEST";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("snapshot_test.db");
        let pool = crate::db::init_pool(&db_path)
            .await
            .expect("init_pool migrations");
        (pool, dir)
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let mut engine = LoroEngine::with_peer_id("device-1").expect("engine");
        engine
            .apply_create_block("BLOCK1", "content", "hello", None, 0)
            .expect("create");

        save_snapshot(&pool, &space, &engine).await.expect("save");

        let loaded = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let expected = engine.export_snapshot().expect("export for compare");
        assert_eq!(
            loaded, expected,
            "loaded bytes must equal the engine's current snapshot bytes"
        );
    }

    #[tokio::test]
    async fn load_returns_none_for_missing_space() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let loaded = load_snapshot(&pool, &space).await.expect("load");
        assert!(loaded.is_none(), "missing row must yield Ok(None)");
    }

    #[tokio::test]
    async fn save_overwrites_existing_row() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let mut engine_v1 = LoroEngine::with_peer_id("device-1").expect("engine1");
        engine_v1
            .apply_create_block("BLOCK1", "content", "first", None, 0)
            .expect("create");
        save_snapshot(&pool, &space, &engine_v1)
            .await
            .expect("save v1");

        // Snapshot a different state.
        let mut engine_v2 = LoroEngine::with_peer_id("device-1").expect("engine2");
        engine_v2
            .apply_create_block("BLOCK1", "content", "first", None, 0)
            .expect("create");
        engine_v2
            .apply_create_block("BLOCK2", "content", "second", None, 1)
            .expect("create2");
        save_snapshot(&pool, &space, &engine_v2)
            .await
            .expect("save v2");

        let loaded = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let expected = engine_v2.export_snapshot().expect("export v2");
        assert_eq!(
            loaded, expected,
            "INSERT OR REPLACE must leave only the latest row visible"
        );

        // Single-row invariant: the PRIMARY KEY on `space_id` is the
        // contract; verify exactly one row exists for this space.
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state WHERE space_id = ?")
                .bind(space.as_str())
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 1, "PRIMARY KEY contract: one row per space_id");
    }

    #[tokio::test]
    async fn rehydrate_engine_from_snapshot_recovers_state() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Engine A: apply some ops, save its snapshot.
        let mut engine_a = LoroEngine::with_peer_id("device-1").expect("engine_a");
        engine_a
            .apply_create_block("BLOCK1", "content", "hello world", None, 0)
            .expect("create");
        engine_a
            .apply_set_property("BLOCK1", "todo_state", Some("DONE"))
            .expect("set_property");
        save_snapshot(&pool, &space, &engine_a).await.expect("save");

        // Engine B: fresh, then load + import.  Reads must match.
        let bytes = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let mut engine_b = LoroEngine::with_peer_id("device-1").expect("engine_b");
        engine_b.import(&bytes).expect("import");

        let snap = engine_b
            .read_block("BLOCK1")
            .expect("read")
            .expect("present");
        assert_eq!(snap.content, "hello world");

        let prop = engine_b
            .read_property("BLOCK1", "todo_state")
            .expect("read_property");
        assert_eq!(prop, Some(Some("DONE".to_string())));
    }

    #[tokio::test]
    async fn rehydrate_registry_seeds_engines_from_persisted_snapshots() {
        let (pool, _dir) = fresh_pool().await;

        // Seed two persisted snapshots, one per space.
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);
        let mut engine_a = LoroEngine::with_peer_id("device-1").expect("engine_a");
        engine_a
            .apply_create_block("BLOCK_A", "content", "in A", None, 0)
            .expect("create");
        save_snapshot(&pool, &space_a, &engine_a)
            .await
            .expect("save a");

        let mut engine_b = LoroEngine::with_peer_id("device-1").expect("engine_b");
        engine_b
            .apply_create_block("BLOCK_B", "content", "in B", None, 0)
            .expect("create");
        save_snapshot(&pool, &space_b, &engine_b)
            .await
            .expect("save b");

        // Fresh registry: rehydrate.
        let registry = LoroEngineRegistry::new();
        let n = rehydrate_registry(&pool, &registry, "device-1").await;
        assert_eq!(n, 2, "both spaces must rehydrate");
        assert_eq!(registry.len(), 2);

        // Engines hold the seeded blocks.
        let mut g = registry.for_space(&space_a, "device-1").expect("a");
        let snap = g.engine_mut().read_block("BLOCK_A").unwrap().unwrap();
        assert_eq!(snap.content, "in A");
        drop(g);

        let mut g = registry.for_space(&space_b, "device-1").expect("b");
        let snap = g.engine_mut().read_block("BLOCK_B").unwrap().unwrap();
        assert_eq!(snap.content, "in B");
    }

    /// #607 / #779 — `reload_registry_from_db` drops stale engines and
    /// rehydrates strictly from `loro_doc_state`. Two cases in one walk:
    /// (a) after a snapshot RESET the table is empty, so the registry
    /// ends up EMPTY (no pre-reset engine survives in memory, and a
    /// follow-up `save_all_engines` persists nothing stale); (b) a space
    /// whose snapshot IS persisted comes back, proving the reload is a
    /// real rehydrate and not just a clear.
    #[tokio::test]
    async fn reload_registry_from_db_drops_stale_engines_and_rehydrates_607() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        // Live engine for A holds pre-reset content; loro_doc_state has
        // NO row for A (the RESET wiped it). B has a persisted snapshot
        // (simulating a future format that carries engine state).
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_PRE", "content", "pre-reset", None, 0)
                .expect("create");
        }
        let mut engine_b = LoroEngine::with_peer_id("device-1").expect("engine_b");
        engine_b
            .apply_create_block("BLOCK_B", "content", "persisted", None, 0)
            .expect("create");
        save_snapshot(&pool, &space_b, &engine_b)
            .await
            .expect("save b");

        let n = reload_registry_from_db(&pool, &registry, "device-1").await;
        assert_eq!(n, 1, "only the persisted space must rehydrate");
        assert_eq!(registry.len(), 1, "stale engine for A must be dropped");

        // A: fresh lazy engine, pre-reset block gone.
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("a");
            assert!(
                g.engine_mut().read_block("BLOCK_PRE").unwrap().is_none(),
                "pre-reset content must not survive the reload"
            );
        }
        // B: rehydrated from its persisted snapshot.
        {
            let mut g = registry.for_space(&space_b, "device-1").expect("b");
            let snap = g.engine_mut().read_block("BLOCK_B").unwrap().unwrap();
            assert_eq!(snap.content, "persisted");
        }

        // (a) continued: with loro_doc_state now empty for A, a simulated
        // exit-save persists nothing stale — the #779 boot source stays
        // clean. (B's row is refreshed, which is fine.)
        sqlx::query("DELETE FROM loro_doc_state")
            .execute(&pool)
            .await
            .expect("wipe");
        registry.clear();
        let n = reload_registry_from_db(&pool, &registry, "device-1").await;
        assert_eq!(n, 0, "empty loro_doc_state must rehydrate nothing");
        assert_eq!(registry.len(), 0);
        let saved = save_all_engines(&pool, &registry).await;
        assert_eq!(saved, 0, "exit-save over an empty registry writes nothing");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            rows, 0,
            "loro_doc_state must stay empty after the simulated exit-save"
        );
    }

    #[tokio::test]
    async fn save_all_engines_persists_every_registered_engine() {
        let (pool, _dir) = fresh_pool().await;

        // Build a registry with two engines populated through the
        // normal lazy path — write distinct blocks into each.
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        {
            let mut g = registry.for_space(&space_a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        {
            let mut g = registry.for_space(&space_b, "device-1").expect("b");
            g.engine_mut()
                .apply_create_block("BLOCK_B", "content", "in B", None, 0)
                .expect("create");
        }

        let n = save_all_engines(&pool, &registry).await;
        assert_eq!(n, 2, "both spaces must snapshot");

        // The persisted bytes must reproduce the engine's state.
        let bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load")
            .expect("present");
        let mut hydrated = LoroEngine::with_peer_id("device-1").expect("engine");
        hydrated.import(&bytes).expect("import");
        let snap = hydrated.read_block("BLOCK_A").unwrap().unwrap();
        assert_eq!(snap.content, "in A");
    }

    /// Smoke test for the `#[cfg(test)]` `tokio::spawn` seam in
    /// [`spawn_periodic_snapshot`]. Drives the real spawned task end to
    /// end: install the process-global state, register + mutate an
    /// engine, spawn the periodic task with a 1-second cadence, then poll
    /// `loro_doc_state` until the engine's snapshot row appears. The task
    /// skips its first `interval.tick()` and pulls state from
    /// `crate::loro::shared::get()`, so this exercises the spawn, the tick
    /// loop, and the `save_all_engines` call the seam exists to cover.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_periodic_snapshot_persists_engine_state() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_PERIODIC);

        // Install fresh process-global state and register an engine the
        // task can find via `crate::loro::shared::get()`. Mutate it so
        // the exported snapshot is non-trivial.
        let state = crate::loro::shared::install_for_test();
        {
            let mut g = state
                .registry
                .for_space(&space, "device-periodic")
                .expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_PERIODIC", "content", "tick", None, 0)
                .expect("create");
        }

        // Spawn the periodic task (1s cadence). The first tick is skipped,
        // so the first persist lands ~1s in.
        let shutdown = Arc::new(AtomicBool::new(false));
        spawn_periodic_snapshot(pool.clone(), shutdown.clone(), 1);

        // Poll for the row rather than sleeping a fixed interval: bounded
        // loop, ~5s total timeout, short sleeps in between. Deterministic
        // and non-flaky — succeeds as soon as the snapshot lands.
        let mut persisted = false;
        for _ in 0..50 {
            let row = load_snapshot(&pool, &space).await.expect("load");
            if row.is_some() {
                persisted = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Stop the task before asserting so a failure doesn't leave it
        // running against a half-torn-down pool.
        shutdown.store(true, Ordering::Relaxed);

        assert!(
            persisted,
            "periodic snapshot task should persist a loro_doc_state row \
             for the space within ~5s"
        );
    }
}
