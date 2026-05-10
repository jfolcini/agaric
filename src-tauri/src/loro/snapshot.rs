//! Per-space LoroDoc snapshot persistence — PEND-09 Phase 2 day-6.
//!
//! ## Why this exists
//!
//! [`LoroEngineRegistry`] is currently a process-local
//! `HashMap<SpaceId, LoroEngine>` that is rebuilt from scratch on every
//! process restart — engines are instantiated lazily on first hit and
//! the `LoroDoc` only contains state derived from ops applied during
//! the current process lifetime.  For Phase-1 shadow mode this is
//! sufficient: parity samples are evaluated within a single op-apply,
//! and a freshly-instantiated engine is a valid baseline.
//!
//! For Phase-2 cutover the engine becomes **authoritative** — the
//! materializer projects from `LoroDoc` state into SQL.  A cold-start
//! engine would project an empty doc on top of existing SQL state,
//! corrupting the user's workspace.  The plan (Q4 from
//! `pending/PEND-09-crdt-migration.md`, day-6 spec captured in
//! `SESSION-LOG.md` Session 698 Phase 2 day-6 entry) says: persist
//! per-space `LoroDoc` snapshots in a `loro_doc_state` SQLite table,
//! rehydrate on app boot, periodically re-snapshot in the background.
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
//!   Invasive — every caller of `merge::shadow_apply` would need to
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

/// Persist the engine's current snapshot to `loro_doc_state`.
///
/// Replaces any existing row for `space_id` (`INSERT OR REPLACE`).
/// `op_count` resets to 0 on every save — the column is reserved for a
/// future "snapshot every N ops" cadence (Phase-2 cutover plan option
/// archived in `SESSION-LOG.md` Session 698 Phase 2 day-6 entry) and is
/// currently unused by the time-driven scheduler.
pub async fn save_snapshot(
    pool: &SqlitePool,
    space_id: &SpaceId,
    engine: &LoroEngine,
) -> Result<(), AppError> {
    let bytes = engine.export_snapshot()?;
    let updated_at = now_ms();
    sqlx::query(
        "INSERT OR REPLACE INTO loro_doc_state \
         (space_id, snapshot, updated_at, op_count) \
         VALUES (?, ?, ?, 0)",
    )
    .bind(space_id.as_str())
    .bind(bytes)
    .bind(updated_at)
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
                "loro-shadow: rehydrate_registry: load_all_space_snapshots failed; \
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
                    "loro-shadow: rehydrate_registry: with_peer_id failed; skipping space",
                );
                continue;
            }
        };
        if let Err(e) = engine.import(&bytes) {
            tracing::warn!(
                space_id = %space_id_str,
                error = %e,
                "loro-shadow: rehydrate_registry: import failed; skipping space",
            );
            continue;
        }
        registry.install_engine(space_id, engine);
        ok += 1;
    }
    ok
}

/// Walk the registry and persist every engine's current snapshot.  Used
/// by the periodic scheduler.  Per-space errors are logged + continued
/// so one bad space never blocks the rest.
///
/// Returns the number of spaces successfully snapshotted.
pub async fn save_all_engines(pool: &SqlitePool, registry: &LoroEngineRegistry) -> usize {
    // We snapshot under the registry lock — `export_snapshot` is a
    // read-only Loro op, fast in absolute terms (single-MiB doc per
    // SPIKE-REPORT.md §3) but it does hold the per-space mutex for
    // its duration.  That's acceptable at the 5-minute snapshot
    // cadence: the materializer's apply rate is bounded by human
    // typing, the engine is rarely contended, and the alternative
    // (clone the whole `HashMap`, drop the lock, snapshot each
    // engine) would double the peak memory.
    let pairs = registry.snapshot_all_engines();

    let mut ok = 0usize;
    for (space_id, bytes_result) in pairs {
        let bytes = match bytes_result {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id,
                    error = %e,
                    "loro-shadow: save_all_engines: export_snapshot failed; skipping space",
                );
                continue;
            }
        };
        let updated_at = now_ms();
        let res = sqlx::query(
            "INSERT OR REPLACE INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count) \
             VALUES (?, ?, ?, 0)",
        )
        .bind(space_id.as_str())
        .bind(bytes)
        .bind(updated_at)
        .execute(pool)
        .await;
        match res {
            Ok(_) => ok += 1,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id,
                    error = %e,
                    "loro-shadow: save_all_engines: INSERT OR REPLACE failed; skipping space",
                );
            }
        }
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

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
}
