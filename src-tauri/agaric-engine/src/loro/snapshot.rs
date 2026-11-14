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
//! - [`load_snapshot`] — reads back the bytes for a given `space_id`,
//!   returning `Ok(None)` if no row exists.
//! - [`load_all_space_snapshots`] — enumerate every persisted
//!   `(space_id, snapshot)` pair.  Used by the eager-load boot pass
//!   that rehydrates the registry without any synchronous-async glue
//!   in `LoroEngineRegistry::for_space` (see decision note below).
//! - [`save_all_engines`] — walk the registry, persist every dirty space in
//!   one transaction: all of them or none (#6521).
//! - [`save_engines_and_advance_cursor`] — the pass the periodic, background,
//!   exit, session-end, mobile-suspend and compaction triggers run: [`save_all_engines`],
//!   then the apply cursor moves to what it persisted, so boot replays only the
//!   ops after it (#5418).
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
//! `load_snapshot` returns `Result<_, AppError>`.
//! The periodic scheduler ([`save_all_engines`]) is the place that
//! must NEVER abort the process: a pass that fails logs `tracing::warn!`,
//! writes nothing, and leaves its spaces dirty for the next one.

use sqlx::SqlitePool;

use crate::loro::engine::{ENGINE_FORMAT_VERSION, LoroEngine};
use crate::loro::registry::LoroEngineRegistry;
use agaric_core::error::AppError;
use agaric_store::space::SpaceId;

/// Wall-clock ms-since-Unix-epoch.  Returns `0` on the
/// (impossible-in-practice) case where the system clock is before
/// `UNIX_EPOCH`, matching `parity_sink::default_retention_cutoff_ms`'s
/// fail-soft convention.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The highest locally-authored `op_log.seq`, read before a pass collects any
/// engine (#5418).
///
/// An op's engine write normally commits with the op, so an export taken after
/// this read holds every op at or below it. Some engine writes land after the
/// commit instead:
///
/// * the post-commit fan-out of the delete, restore and purge commands
///   (`commands::blocks::crud`); the batch delete and every restore and purge
///   make all of their engine writes there. A pass that reads the head before
///   the fan-out lands persists rows without it and moves the cursor past the
///   op. The fan-out re-dirties its engine, so the next pass persists it; a
///   crash before then leaves the engine without it.
/// * an op parked in `materializer_retry_queue`, durable on its own.
///
/// Draft recovery (`recovery::draft_recovery`), the empty-block sweep
/// (`soft_delete::empty_block_sweep`), the boot repairs (`repair`) and boot
/// replay's delete and restore cohort fan-outs (`recovery::replay`, #5630,
/// #5647) also write the engine after commit, but they run only at boot and await those
/// writes before the periodic pass is spawned, so no pass reads a head between
/// their commit and their engine write.
///
/// Replicated rows never reach an engine through the op log. A read error
/// fails the pass: a row stamped below what it holds is an op boot applies a
/// second time (#6521).
async fn op_log_head(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let head = sqlx::query_scalar!(
        r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log WHERE is_replicated = 0"#
    )
    .fetch_one(pool)
    .await?;
    Ok(head.unwrap_or(0))
}

/// Write one `loro_doc_state` row, replacing any existing one for `space_id`.
///
/// `op_count` resets to 0 on every save — the column is reserved for a future
/// "snapshot every N ops" cadence and is unused by the time-driven scheduler.
async fn write_snapshot_row<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    space_id: &SpaceId,
    bytes: Vec<u8>,
    applied_through_seq: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR REPLACE INTO loro_doc_state \
         (space_id, snapshot, updated_at, op_count, applied_through_seq) \
         VALUES (?, ?, ?, 0, ?)",
    )
    .bind(space_id.as_str())
    .bind(bytes)
    .bind(now_ms())
    .bind(applied_through_seq)
    .execute(db)
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
/// before any op-apply runs.
///
/// A snapshot that will not import is an error and installs nothing (#6525):
/// a skipped space would get an empty engine on first access, and the next save
/// would replace the unreadable blob with it under the same PeerID. Boot turns
/// the error into its fatal dialog.
///
/// Every snapshot is imported before any index is rebuilt, and one log line
/// marks the boundary, so `scripts/measure-boot.mjs` times the two passes
/// apart (#5707).
///
/// Returns the number of engines rehydrated.
pub async fn rehydrate_registry(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
) -> Result<usize, AppError> {
    let started = std::time::Instant::now();
    let rows = load_all_space_snapshots(pool).await?;

    let mut imported = Vec::with_capacity(rows.len());
    for (space_id_str, bytes) in rows {
        // #792: derive the engine's PeerID from the registry's current
        // peer-id epoch (installed at boot from `app_settings`) so rehydrated
        // engines and lazily-created ones agree on the device's peer id.
        let mut engine = LoroEngine::with_peer_id_epoch(device_id, registry.peer_epoch())?;
        match engine.import_deferring_index(&bytes) {
            Ok(needs_index) => {
                imported.push((SpaceId::from_trusted(&space_id_str), engine, needs_index));
            }
            Err(e) => return Err(unreadable_snapshot(&space_id_str, &engine, &e)),
        }
    }
    tracing::info!(
        imported_spaces = imported.len(),
        elapsed_ms = started.elapsed().as_millis(),
        "loro: imported per-space LoroDoc snapshots from loro_doc_state (index rebuild next)",
    );
    let ok = imported.len();
    for (space_id, mut engine, needs_index) in imported {
        if needs_index {
            engine.rebuild_index_after_import();
        }
        registry.install_engine(space_id, engine);
    }
    Ok(ok)
}

/// The error for a snapshot that failed to import into `engine`, worded for the
/// boot dialog: a stamp newer than this build names the fix.
fn unreadable_snapshot(space_id: &str, engine: &LoroEngine, cause: &AppError) -> AppError {
    let supported = i64::from(ENGINE_FORMAT_VERSION);
    match engine.format_version_stamp() {
        Some(found) if found > supported => AppError::Snapshot(format!(
            "This vault was last opened by a newer version of Agaric (engine format {found}; \
             this version reads up to {supported}). Install that newer version to open it."
        )),
        _ => AppError::Snapshot(format!(
            "The saved state of space {space_id} cannot be read ({cause}). Agaric stopped \
             rather than overwrite it."
        )),
    }
}

/// Held by [`save_all_engines`] from before its collect to after its last
/// write. An export collected earlier but written later would leave a row
/// older than its engine while the space reads clean, and the next pass would
/// advance that row's watermark past ops its blob lacks.
static ONE_PASS_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What one [`save_all_engines`] pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SavePass {
    /// Spaces whose snapshot was written.
    pub saved: usize,
    /// The op-log head the pass read before collecting any engine, when it
    /// wrote its rows: each op at or below it is then in `loro_doc_state`.
    /// `None` when it wrote nothing: the head read, an export or a write
    /// failed, or the registry was cleared mid-pass.
    pub persisted_through: Option<i64>,
}

/// Walk the registry and persist every dirty engine's current snapshot, all
/// of them or none ([`write_pass`]). A pass that fails is logged and leaves
/// its spaces dirty for the next one. Passes run one at a time, whoever starts
/// them (#6521).
pub async fn save_all_engines(pool: &SqlitePool, registry: &LoroEngineRegistry) -> SavePass {
    let _pass = ONE_PASS_AT_A_TIME.lock().await;
    // Issue #153 / #2205 / #2201 — `snapshot_dirty_engines` collects the
    // per-space engine `Arc`s of ONLY the dirty spaces under the registry's
    // locks, then per space takes that engine's own lock for the O(1)
    // `LoroDoc` *handle* clone, and runs each (comparatively slow) snapshot
    // export with no lock held at all. Engine applies are therefore blocked
    // only for the O(1) handle clone of their own space, never for the
    // O(spaces x export) serialization. A `LoroDoc` clone is a reference
    // clone (shared underlying doc), so this does NOT double peak memory —
    // see `LoroEngineRegistry::snapshot_dirty_engines` for the full
    // rationale and the (unchanged) cross-space consistency contract.
    //
    // /C2: read the head BEFORE collecting any engine, so each export this
    // pass takes holds the ops at or below it (`op_log_head` lists the engine
    // writes that land later). Rows are stamped with it.
    let pass = async {
        let applied_through_seq = op_log_head(pool).await?;
        // #607 review: capture the clear-generation BEFORE collecting doc
        // handles; `write_pass` checks it before it commits.
        let generation = registry.generation();
        let pairs = registry.snapshot_dirty_engines();
        let written = write_pass(pool, registry, generation, pairs, applied_through_seq).await?;
        Ok::<_, AppError>((written, applied_through_seq))
    };
    match pass.await {
        Ok((written, applied_through_seq)) => {
            // #2201 — a space re-marked since its export was collected carries
            // a greater stamp, stays dirty and is persisted again next pass.
            for (space_id, mark_stamp) in &written {
                registry.clear_dirty_if_unchanged(space_id, *mark_stamp);
            }
            SavePass {
                saved: written.len(),
                persisted_through: Some(applied_through_seq),
            }
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "loro:save_all_engines: the pass wrote nothing; its spaces stay dirty",
            );
            SavePass {
                saved: 0,
                persisted_through: None,
            }
        }
    }
}

/// Write one pass's rows and move every other row's stamp up to the pass's,
/// in one transaction (#6521). Returns the spaces written, each with the dirty
/// stamp its export was collected under.
///
/// Boot applies the local ops above the lowest stamp to every engine
/// (`recovery::replay`), and an op applied to an engine that holds it is a new
/// write, over whatever a peer wrote to the same block since. So no row may
/// hold an op above another row's stamp: a pass that cannot write one space
/// writes none, and a kill between two of its rows leaves none.
///
/// ## The rows the pass did not write (#3309)
///
/// Since #2201 only DIRTY spaces are re-encoded. A space that was edited once
/// and then went quiescent would keep its first stamp forever, and
/// `recovery::replay::heal_orphaned_apply_cursor` rewinds the apply cursor to
/// the lowest one. A space outside `pairs` was clean at the collect, so its
/// row equals its engine, and every row has an engine behind it: boot installs
/// one for each row or stops (#6525), and a pass writes rows only for engines.
/// That engine holds the local ops up to the pass's head, bar the writes
/// [`op_log_head`] lists, so its stamp moves with the others.
///
/// This holds for a rehydrated engine only AFTER
/// `recovery::boot::recover_at_boot` has run: between rehydration and the
/// heal+replay, an engine reflects only its own row's stamp while the op log
/// may be far ahead. Production ordering guarantees it — `lib.rs::run` calls
/// `recover_and_bootstrap` BEFORE `spawn_background_tasks` starts the periodic
/// pass, and the exit-time save runs later still — so no pass can observe that
/// window. A future change that starts a snapshot pass before boot recovery
/// would break this premise and the stamp every row records.
///
/// `updated_at` is left alone: it records when the BLOB was written.
///
/// ## The generation check (#607, #4020, #2910)
///
/// `generation` is the clear-generation the pass captured before its collect.
/// A `LoroEngineRegistry::clear` (test-only) or an
/// [`LoroEngineRegistry::evict_space`] (a purged space's engine dropped with
/// its row) since then means `pairs` may hold an engine whose row is gone, and
/// the rows may belong to a wiped or shrunk table: nothing is committed. It is
/// checked once, last, so that it also covers a pass with no dirty space,
/// which writes no row and still moves the stamps.
async fn write_pass(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    generation: u64,
    pairs: Vec<(SpaceId, u64, Result<Vec<u8>, AppError>)>,
    applied_through_seq: i64,
) -> Result<Vec<(SpaceId, u64)>, AppError> {
    // allow-raw-tx: engine persistence (`loro_doc_state`); no op_log write.
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "loro_snapshot_pass").await?;
    let mut written = Vec::with_capacity(pairs.len());
    for (space_id, mark_stamp, bytes) in pairs {
        write_snapshot_row(&mut *tx, &space_id, bytes?, applied_through_seq).await?;
        written.push((space_id, mark_stamp));
    }
    // `<` so a stamp is never walked back.
    sqlx::query("UPDATE loro_doc_state SET applied_through_seq = ? WHERE applied_through_seq < ?")
        .bind(applied_through_seq)
        .bind(applied_through_seq)
        .execute(&mut *tx)
        .await?;
    if registry.generation() != generation {
        return Err(AppError::Snapshot(
            "the engine registry was cleared or a space evicted mid-pass (#607, #2910)".to_owned(),
        ));
    }
    tx.commit().await?;
    Ok(written)
}

/// One production snapshot pass (#5418): [`save_all_engines`], then the apply
/// cursor moves up to the op-log head the pass persisted, so the next boot
/// replays only the ops committed after it instead of the whole session.
///
/// Boot replay restores two things for an op: its engine state, which the
/// pass has just made durable (bar the late writes `op_log_head` lists), and
/// its per-block index fan-out (FTS, links,
/// tag refs; #3298), which lives in the background queue's memory until it
/// runs. So the queue is drained before the cursor stops covering those ops.
/// A pass that wrote nothing moves nothing: a space whose first write failed
/// has no row for the boot heal's `MIN(applied_through_seq)` to see, and only
/// the old cursor still replays its ops.
///
/// The rows are committed before the drain, so a kill during it, or a queue
/// that cannot drain, leaves the cursor behind them. Boot reads the rows'
/// stamp and applies only the ops above it (`recovery::replay`, #6521).
///
/// Returns `save_all_engines`' [`SavePass`]: compaction reads its
/// `persisted_through` before it deletes any op (#6518).
pub async fn save_engines_and_advance_cursor(
    pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
) -> SavePass {
    let pass = save_all_engines(pool, &materializer.loro_state().registry).await;
    let Some(head) = pass.persisted_through else {
        return pass;
    };
    if let Err(e) = materializer.flush_background().await {
        tracing::warn!(
            error = %e,
            "loro: background queue did not drain; apply cursor left in place (#5418)",
        );
        return pass;
    }
    let advanced = match pool.acquire().await {
        Ok(mut conn) => crate::apply::kernel::advance_apply_cursor(&mut conn, head).await,
        Err(e) => Err(e.into()),
    };
    if let Err(e) = advanced {
        tracing::warn!(
            error = %e,
            head,
            "loro: apply cursor advance failed; the next boot replays from the old cursor (#5418)",
        );
    }
    pass
}

/// Default cadence for the periodic snapshot task (5 minutes).
///
/// Restored after the parity flush task — which hosted the
/// `save_all_engines` call on its tick — was deleted, leaving snapshots
/// unpersisted (the resulting empty `loro_doc_state` + advancing apply
/// cursor wedged the materializer). The engine applies at human-typing
/// rates, so a 5-minute snapshot bounds the boot-replay tail to a
/// handful of ops while keeping the snapshot cost negligible.
pub const SNAPSHOT_INTERVAL_SECS: u64 = 300;

/// Spawn the periodic Loro snapshot task.
///
/// Every `interval_secs` it runs [`save_engines_and_advance_cursor`] over the
/// materializer's engine registry, so the next boot rehydrates without
/// replaying the full op-log. The task runs for
/// the app's lifetime and stops once `shutdown` flips. A failed pass is
/// logged inside [`save_all_engines`], so a transient SQL/Loro failure never
/// crashes the app.
/// `spawn` injects the async executor: the app passes
/// `|fut| { tauri::async_runtime::spawn(fut); }` (so `agaric-engine` stays
/// tauri-free), tests pass `|fut| { tokio::spawn(fut); }` (#2621, wave E1).
pub fn spawn_periodic_snapshot(
    pool: SqlitePool,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    interval_secs: u64,
    materializer: crate::materializer::Materializer,
    spawn: impl FnOnce(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>),
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    // Fire-and-forget: the task lives for the process lifetime and stops
    // when `shutdown` flips. The spawned JoinHandle is intentionally discarded
    // by the caller-supplied `spawn`.
    spawn(Box::pin(async move {
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
            let saved = save_engines_and_advance_cursor(&pool, &materializer)
                .await
                .saved;
            if saved > 0 {
                tracing::debug!(spaces = saved, "loro: periodic snapshot persisted");
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loro::engine::PropertyValue;
    use tempfile::TempDir;

    /// One space's save, outside `save_all_engines`' dirty tracking.
    async fn save_snapshot(
        pool: &SqlitePool,
        space_id: &SpaceId,
        engine: &LoroEngine,
    ) -> Result<(), AppError> {
        let applied_through_seq = op_log_head(pool).await?;
        let bytes = engine.export_snapshot()?;
        write_snapshot_row(pool, space_id, bytes, applied_through_seq).await?;
        Ok(())
    }

    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    /// Distinct space for the periodic-snapshot smoke test. The global
    /// registry is shared within a test binary, so this ULID must not
    /// collide with `SPACE_A`/`SPACE_B` above.
    const SPACE_PERIODIC: &str = "01J0PERIODICSNAP000000TEST";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        agaric_store::test_support::test_pool().await
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
            .read_property_typed("BLOCK1", "todo_state")
            .expect("read_property_typed");
        assert_eq!(prop, Some(PropertyValue::Str("DONE".to_string())));
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
        let n = rehydrate_registry(&pool, &registry, "device-1")
            .await
            .expect("rehydrate");
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

    /// #5707: `scripts/measure-boot.mjs` takes the first line with this prefix
    /// as the end of the import pass, so it is logged once, after every space.
    #[test]
    fn rehydrate_registry_logs_the_import_milestone_once_after_every_space_5707() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (n, logs) = crate::loro::engine::test_log_capture::capture_logs(|| {
            rt.block_on(async {
                let (pool, _dir) = fresh_pool().await;
                for (space, block) in [(SPACE_A, "BLOCK_A"), (SPACE_B, "BLOCK_B")] {
                    let mut engine = LoroEngine::with_peer_id("device-1").expect("engine");
                    engine
                        .apply_create_block(block, "content", "x", None, 0)
                        .expect("create");
                    save_snapshot(&pool, &SpaceId::from_trusted(space), &engine)
                        .await
                        .expect("save");
                }
                rehydrate_registry(&pool, &LoroEngineRegistry::new(), "device-1")
                    .await
                    .expect("rehydrate")
            })
        });
        assert_eq!(n, 2);
        let milestones: Vec<&str> = logs
            .lines()
            .filter(|l| l.contains("loro: imported per-space"))
            .collect();
        assert_eq!(milestones.len(), 1, "{logs}");
        assert!(milestones[0].contains("imported_spaces=2"), "{logs}");
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

        let n = save_all_engines(&pool, &registry).await.saved;
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

    /// #2201 — the periodic tick re-encodes ONLY changed spaces. After both
    /// spaces are persisted once, mutating A alone must re-encode A and leave
    /// B's `loro_doc_state` row byte-for-byte untouched (proven via its
    /// `updated_at`), and the pass reports exactly one space persisted.
    #[tokio::test]
    async fn save_all_engines_persists_only_dirty_spaces_2201() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        for (space, id) in [(&space_a, "BLOCK_A"), (&space_b, "BLOCK_B")] {
            let mut g = registry.for_space(space, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block(id, "content", id, None, 0)
                .expect("create");
        }

        // First pass persists BOTH dirty spaces and clears both flags.
        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 2, "first pass persists both dirty spaces");
        assert_eq!(registry.dirty_count(), 0, "both spaces clean after persist");

        // Capture B's row so a later rewrite would be observable.
        let b_updated_before: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(space_b.as_str())
                .fetch_one(&pool)
                .await
                .expect("b row");

        // `now_ms` is ms-resolution — sleep so a rewrite of B would advance it.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        // Mutate ONLY space A.
        {
            let mut g = registry
                .for_space(&space_a, "device-1")
                .expect("for_space a");
            g.engine_mut()
                .apply_create_block("BLOCK_A2", "content", "again", None, 1)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 1, "only A dirty after mutating A");

        // Second pass must re-encode ONLY A.
        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 1, "second pass persists only the dirty space (A), not B");
        assert_eq!(registry.dirty_count(), 0, "A clean after its persist");

        let b_updated_after: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(space_b.as_str())
                .fetch_one(&pool)
                .await
                .expect("b row after");
        assert_eq!(
            b_updated_before, b_updated_after,
            "a clean space must NOT be re-encoded — its row must be untouched"
        );

        // A's row is present and reflects the new block.
        let a_bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load a")
            .expect("a present");
        let mut probe = LoroEngine::with_peer_id("device-1").expect("probe");
        probe.import(&a_bytes).expect("import a");
        assert!(
            probe.read_block("BLOCK_A2").expect("read").is_some(),
            "A's re-encoded snapshot must contain the block mutated this tick"
        );
    }

    /// Seed a `loro_doc_state` row directly, as if it had been persisted by
    /// an earlier session.
    async fn seed_row(pool: &SqlitePool, space_id: &str, applied_through_seq: i64) {
        sqlx::query(
            "INSERT OR REPLACE INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) \
             VALUES (?, X'00', 1767225600000, 0, ?)",
        )
        .bind(space_id)
        .bind(applied_through_seq)
        .execute(pool)
        .await
        .expect("seed loro_doc_state row");
    }

    /// Put one locally-authored row at `seq` in the op log, so a pass reads
    /// it as the op-log head (#5418).
    async fn seed_op_log_head(pool: &SqlitePool, seq: i64) {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('device-1', ?, NULL, ?, 'create_block', '{}', 1767225600000)",
        )
        .bind(seq)
        .bind(format!("hash-{seq}"))
        .execute(pool)
        .await
        .expect("seed op_log head");
    }

    /// Install a CLEAN engine for `space_id`, as boot rehydration does for
    /// every persisted space. `install_engine` does not mark the space
    /// dirty, so the registry state matches "persisted earlier, untouched
    /// since" — the shape whose stamp a pass moves without writing its row.
    fn install_clean_engine(registry: &LoroEngineRegistry, space_id: &str) {
        registry.install_engine(
            SpaceId::from_trusted(space_id),
            LoroEngine::with_peer_id("device-1").expect("engine"),
        );
        assert_eq!(
            registry.dirty_count(),
            0,
            "install_engine must not mark the space dirty"
        );
    }

    async fn watermark_of(pool: &SqlitePool, space_id: &str) -> i64 {
        sqlx::query_scalar("SELECT applied_through_seq FROM loro_doc_state WHERE space_id = ?")
            .bind(space_id)
            .fetch_one(pool)
            .await
            .expect("watermark")
    }

    /// #3309 — a space that was persisted once and then went QUIESCENT must
    /// not pin `MIN(applied_through_seq)` forever.
    ///
    /// Since #2201 only dirty spaces are re-encoded, so B's row (written by
    /// a long-past session at watermark 1) used to keep that watermark for
    /// the lifetime of the vault. `heal_orphaned_apply_cursor` rewinds the
    /// global apply cursor to `MIN(applied_through_seq)`, so every boot
    /// re-drove the whole op-log tail through the foreground materializer.
    /// The pass must therefore advance the watermark of the spaces it did
    /// NOT re-encode — while still not re-encoding them (#2201).
    #[tokio::test]
    async fn save_all_engines_advances_watermark_of_quiescent_space_3309() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);

        // B: edited once long ago (watermark 1), never touched since — it is
        // absent from the registry's dirty set for good, but (as in
        // production) boot rehydration DID install its engine.
        seed_row(&pool, SPACE_B, 1).await;
        install_clean_engine(&registry, SPACE_B);
        let b_blob_before: Vec<u8> =
            sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b blob before");
        let b_updated_before: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b updated_at before");

        // A is the space the user actually works in; the op log has run far
        // ahead of B's frozen watermark.
        seed_op_log_head(&pool, 500).await;
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }

        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 1, "only the dirty space A is re-encoded");

        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            500,
            "the re-encoded space records the head the pass read"
        );
        assert_eq!(
            watermark_of(&pool, SPACE_B).await,
            500,
            "the quiescent space's watermark must be advanced too — otherwise it \
             pins MIN(applied_through_seq) and every boot rewinds to it (#3309)"
        );

        // ...but #2201 still holds: B's BLOB is not re-encoded and its
        // blob-write timestamp is untouched.
        let b_blob_after: Vec<u8> =
            sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b blob after");
        assert_eq!(
            b_blob_before, b_blob_after,
            "advancing the watermark must not re-encode a clean space (#2201)"
        );
        let b_updated_after: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b updated_at after");
        assert_eq!(
            b_updated_before, b_updated_after,
            "updated_at records when the BLOB was written; no blob was written for B"
        );
    }

    /// #4020 — a snapshot RESET racing the pass must stop it from moving the
    /// clean rows' stamps, and that must hold when the dirty set is EMPTY: the
    /// quiescent vault, where moving them is all the pass does.
    ///
    /// Driven against [`write_pass`] directly: the generation is captured
    /// INSIDE `save_all_engines`, so a clear that lands between the capture and
    /// the write cannot be scheduled from the outside. The matching positive
    /// direction — same shape, generation unchanged, row advanced — is
    /// `save_all_engines_advances_watermark_of_quiescent_space_3309`.
    #[tokio::test]
    async fn clean_watermark_refresh_bails_when_the_registry_was_cleared_4020() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();

        // The quiescent shape: one persisted space, its engine rehydrated and
        // clean, nothing dirty anywhere.
        seed_row(&pool, SPACE_B, 1).await;
        install_clean_engine(&registry, SPACE_B);
        assert_eq!(registry.dirty_count(), 0, "no dirty space in this pass");

        // What `save_all_engines` captures before its collect.
        let generation = registry.generation();

        // …and the RESET that lands before the write.
        registry.clear();
        assert_ne!(
            registry.generation(),
            generation,
            "clear() must bump the generation, or this test proves nothing"
        );

        let pass = write_pass(&pool, &registry, generation, Vec::new(), 499).await;

        assert!(
            matches!(pass, Err(AppError::Snapshot(_))),
            "a pass whose engines the RESET destroyed must write nothing \
             (#607/#4020): {pass:?}"
        );
        assert_eq!(
            watermark_of(&pool, SPACE_B).await,
            1,
            "the pre-reset watermark must survive: advancing it would claim a wiped \
             table's row reflects the op-log and suppress the rebuild that repairs it"
        );
    }

    /// #6521 — a pass that cannot write one space writes none. Boot replays
    /// the ops above the lowest stamp onto every engine, so a row left holding
    /// ops above another row's stamp gets them a second time, as new writes
    /// over whatever a peer wrote since.
    ///
    /// Two dirty spaces and one quiescent space (C). The trigger refuses the
    /// second row of the pass, whichever space the pass writes first.
    #[tokio::test]
    async fn a_pass_that_cannot_write_one_space_writes_none_6521() {
        const SPACE_C: &str = "01D0Z9Z0Z9Z0Z9Z0Z9Z0Z9Z0Z9";

        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        seed_row(&pool, SPACE_A, 1).await;
        seed_row(&pool, SPACE_B, 1).await;
        seed_row(&pool, SPACE_C, 1).await;
        install_clean_engine(&registry, SPACE_C);
        seed_op_log_head(&pool, 500).await;

        for (space, block) in [(&space_a, "BLOCK_A0"), (&space_b, "BLOCK_B0")] {
            let mut g = registry.for_space(space, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block(block, "content", "mutation", None, 0)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 2, "A and B are both dirty");

        sqlx::query(
            "CREATE TRIGGER poison_the_second_row_of_a_pass \
             BEFORE INSERT ON loro_doc_state \
             WHEN EXISTS (SELECT 1 FROM loro_doc_state WHERE applied_through_seq = 500) \
             BEGIN SELECT RAISE(ABORT, 'simulated persist failure'); END",
        )
        .execute(&pool)
        .await
        .expect("create poison trigger");

        let pass = save_all_engines(&pool, &registry).await;
        assert_eq!(
            (pass.saved, pass.persisted_through),
            (0, None),
            "the pass saved nothing"
        );
        for space in [SPACE_A, SPACE_B, SPACE_C] {
            assert_eq!(
                watermark_of(&pool, space).await,
                1,
                "no row may move past another's stamp: {space}"
            );
        }
        for space in [SPACE_A, SPACE_B] {
            let blob: Vec<u8> =
                sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                    .bind(space)
                    .fetch_one(&pool)
                    .await
                    .expect("blob");
            assert_eq!(blob, vec![0u8], "the row is the one it had: {space}");
        }
        assert_eq!(registry.dirty_count(), 2, "and both spaces stay dirty");

        sqlx::query("DROP TRIGGER poison_the_second_row_of_a_pass")
            .execute(&pool)
            .await
            .expect("drop poison trigger");
        let pass = save_all_engines(&pool, &registry).await;
        assert_eq!(
            (pass.saved, pass.persisted_through),
            (2, Some(500)),
            "the next pass writes both"
        );
        for space in [SPACE_A, SPACE_B, SPACE_C] {
            assert_eq!(
                watermark_of(&pool, space).await,
                500,
                "every row carries the pass's stamp: {space}"
            );
        }
    }

    /// #6521 — and so does a pass with an export that failed, whichever row
    /// comes first.
    #[tokio::test]
    async fn a_pass_with_a_failed_export_writes_none_6521() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let exported = LoroEngine::with_peer_id("device-1")
            .expect("engine")
            .export_snapshot()
            .expect("export");
        let pairs = vec![
            (SpaceId::from_trusted(SPACE_A), 1, Ok(exported)),
            (
                SpaceId::from_trusted(SPACE_B),
                2,
                Err(AppError::validation("simulated export failure".to_owned())),
            ),
        ];

        let pass = write_pass(&pool, &registry, registry.generation(), pairs, 500).await;

        assert!(pass.is_err(), "the pass fails: {pass:?}");
        assert!(
            load_snapshot(&pool, &SpaceId::from_trusted(SPACE_A))
                .await
                .expect("load")
                .is_none(),
            "the row written before the failed export is not kept"
        );
    }

    /// #6521 — a pass that cannot read the op-log head writes nothing: a row
    /// stamped below what it holds is an op boot applies a second time.
    #[tokio::test]
    async fn a_pass_that_cannot_read_the_head_writes_nothing_6521() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        registry
            .for_space(&space_a, "device-1")
            .expect("for_space")
            .engine_mut()
            .apply_create_block("BLOCK_A", "content", "in A", None, 0)
            .expect("create");
        sqlx::query("DROP TABLE op_log")
            .execute(&pool)
            .await
            .expect("drop table");

        let pass = save_all_engines(&pool, &registry).await;

        assert_eq!(
            (pass.saved, pass.persisted_through),
            (0, None),
            "the pass saved nothing"
        );
        assert!(
            load_snapshot(&pool, &space_a)
                .await
                .expect("load")
                .is_none(),
            "no row carries a stamp the pass did not read"
        );
        assert_eq!(registry.dirty_count(), 1, "and the space stays dirty");
    }

    /// #2201 — a per-space persist FAILURE leaves that space dirty so the
    /// next tick retries it (never silently clears a flag whose state was not
    /// persisted). The INSERT is forced to fail by dropping the target table;
    /// the in-memory export still succeeds, only the write fails.
    #[tokio::test]
    async fn save_all_engines_persist_failure_keeps_space_dirty_2201() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 1, "A dirty after mutation");

        // Force the INSERT OR REPLACE to fail (the watermark read targets a
        // different table, so collection + export still succeed).
        sqlx::query("DROP TABLE loro_doc_state")
            .execute(&pool)
            .await
            .expect("drop table");

        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 0, "no space is counted persisted when the INSERT fails");
        assert_eq!(
            registry.dirty_count(),
            1,
            "a failed persist must LEAVE the space dirty for the next tick"
        );
    }

    async fn apply_cursor(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(pool)
        .await
        .expect("apply cursor")
    }

    /// Mutate `space_id`'s engine in `materializer`'s registry, marking it
    /// dirty, as an applied op does.
    fn dirty_engine(materializer: &crate::materializer::Materializer, space_id: &str) {
        let mut g = materializer
            .loro_state()
            .registry
            .for_space(&SpaceId::from_trusted(space_id), "device-1")
            .expect("for_space");
        g.engine_mut()
            .apply_create_block("BLOCK_5418", "content", "applied", None, 0)
            .expect("create");
    }

    /// #5418 — a pass that wrote every dirty engine moves the apply cursor to
    /// the op-log head it read, and stamps the row with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_pass_advances_the_apply_cursor_to_the_op_log_head_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 1, "the dirty space is written");
        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            7,
            "the row is stamped with the head"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            7,
            "boot replay must start after the head the pass persisted"
        );
    }

    /// #5418 — an op with no engine write (an attachment, a SQL-only fallback)
    /// leaves every engine clean. The pass still moves the cursor past it, so
    /// boot does not replay a tail of them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quiescent_pass_advances_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 0, "no engine is dirty");
        assert_eq!(
            apply_cursor(&pool).await,
            7,
            "boot replay must start after the head even when no engine was written"
        );
    }

    /// #5418 — the cursor moves only once every dirty engine is written. A
    /// space whose FIRST write fails has no row, so the boot heal's
    /// `MIN(applied_through_seq)` cannot see it; only the unmoved cursor still
    /// replays its ops. This is the crash before the snapshot commits.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_snapshot_write_leaves_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);
        sqlx::query(
            "CREATE TRIGGER poison_loro_doc_state_insert \
             BEFORE INSERT ON loro_doc_state \
             BEGIN SELECT RAISE(ABORT, 'simulated persist failure'); END",
        )
        .execute(&pool)
        .await
        .expect("create poison trigger");

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 0, "the write failed");
        assert!(
            load_snapshot(&pool, &SpaceId::from_trusted(SPACE_A))
                .await
                .expect("load")
                .is_none(),
            "the space has no row for the boot heal to see"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            0,
            "the cursor must not pass ops no persisted snapshot holds"
        );
    }

    /// #5418 — the cursor moves only once the background queue has drained:
    /// boot replay re-dispatches each replayed op's index fan-out (#3298), so a
    /// cursor past an op whose fan-out is still in memory would lose it to a
    /// crash. A queue that cannot drain (here: shut down) leaves the cursor,
    /// though the rows are written.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undrained_background_queue_leaves_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);
        materializer.shutdown();

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;

        assert_eq!(saved, 1, "the rows do not wait for the queue");
        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            7,
            "the row is stamped with the head"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            0,
            "the cursor must not pass ops whose index fan-out may still be in memory"
        );
    }

    /// #2201 — convergence/liveness smoke test: a writer hammers space A while
    /// save passes run on a multi-thread runtime, exercising the no-deadlock
    /// guarantee (the registry never holds two of its locks at once) and
    /// confirming the system converges — after the writer joins, one final
    /// drained pass persists A's full final state and the loaded snapshot
    /// contains every block the writer created.
    ///
    /// Scope note: this does NOT by itself prove the stamp-race defense (a
    /// flag wrongly cleared mid-persist would still be masked here, because
    /// the writer's final `for_space` re-marks A dirty and Loro exports a full
    /// snapshot each pass, so the final state persists regardless). The actual
    /// "clear must not drop an unpersisted mark" contract is pinned by the two
    /// dedicated unit tests — `concurrent_remark_during_persist_keeps_space_dirty_2201`
    /// and `clear_race_does_not_drop_unpersisted_dirty_flag_2201`. The
    /// concern-1 durability case (a snapshot never written at all) is not
    /// testable at this layer: the op_log / loro_sync_inbox WAL is the durable
    /// source of truth and boot replay backfills any stale/missing snapshot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn save_all_engines_concurrent_mutation_not_lost_2201() {
        use std::sync::Arc;

        const WRITES: usize = 100;

        let (pool, _dir) = fresh_pool().await;
        let registry = Arc::new(LoroEngineRegistry::new());
        let space_a = SpaceId::from_trusted(SPACE_A);

        // Seed + persist so A starts clean.
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("seed");
            g.engine_mut()
                .apply_create_block("SEED", "content", "seed", None, 0)
                .expect("create");
        }
        save_all_engines(&pool, &registry).await;
        assert_eq!(registry.dirty_count(), 0, "A clean after seed persist");

        // Writer task: append blocks to A concurrently with the save passes.
        let writer = {
            let registry = Arc::clone(&registry);
            let space_a = space_a.clone();
            tokio::task::spawn_blocking(move || {
                for i in 0..WRITES {
                    let id = format!("W{i:03}");
                    let position = i64::try_from(i).expect("index fits i64") + 1;
                    let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
                    g.engine_mut()
                        .apply_create_block(&id, "content", &id, None, position)
                        .expect("create");
                }
            })
        };

        // Interleave save passes with the writer.
        for _ in 0..20 {
            let _ = save_all_engines(&pool, &registry).await;
            tokio::task::yield_now().await;
        }
        writer.await.expect("writer task");

        // Final drained pass persists whatever remained dirty.
        let _ = save_all_engines(&pool, &registry).await;
        assert_eq!(
            registry.dirty_count(),
            0,
            "no dirty flag may linger after the final drained pass"
        );

        // The persisted snapshot must reflect the writer's FULL final state.
        let bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load")
            .expect("present");
        let mut probe = LoroEngine::with_peer_id("device-1").expect("probe");
        probe.import(&bytes).expect("import");
        assert!(
            probe.read_block("SEED").expect("read").is_some(),
            "seed block must survive"
        );
        for i in 0..WRITES {
            assert!(
                probe
                    .read_block(&format!("W{i:03}"))
                    .expect("read")
                    .is_some(),
                "the final persisted snapshot must contain every concurrently-written block",
            );
        }
    }

    /// Smoke test for the `#[cfg(test)]` `tokio::spawn` seam in
    /// [`spawn_periodic_snapshot`]. Drives the real spawned task end to
    /// end: construct a materializer, register + mutate an engine in its
    /// registry, hand that same materializer to the periodic task with a
    /// 1-second cadence, then poll `loro_doc_state` until the engine's snapshot row
    /// appears. The task skips its first `interval.tick()` and reads the
    /// materializer it was constructed with (#2249: engine state is an
    /// explicitly threaded value, not a process global), so this exercises
    /// the spawn, the tick loop, and the snapshot pass the seam exists to
    /// cover.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_periodic_snapshot_persists_engine_state() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_PERIODIC);

        // Fresh per-test state, with an engine registered in it that the
        // task will find through the materializer passed to it below. Mutate
        // it so the exported snapshot is non-trivial.
        let materializer = crate::materializer::Materializer::new(pool.clone());
        {
            let mut g = materializer
                .loro_state()
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
        spawn_periodic_snapshot(
            pool.clone(),
            shutdown.clone(),
            1,
            materializer.clone(),
            |fut| {
                tokio::spawn(fut);
            },
        );

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
        materializer.shutdown();

        assert!(
            persisted,
            "periodic snapshot task should persist a loro_doc_state row \
             for the space within ~5s"
        );
    }

    // -----------------------------------------------------------------
    // #2910 — purging a registered space tears down its `loro_doc_state`
    // snapshot row AND evicts its in-memory per-space engine, so the dead
    // space's LoroDoc is never rehydrated at boot nor re-persisted.
    // -----------------------------------------------------------------

    /// A soft-deleted space to purge, and a live space that must survive
    /// unscathed. Local `LoroState` per test (no global-registry sharing),
    /// but keep them distinct for readable failures. Valid Crockford base32.
    const SPACE_PURGE_2910: &str = "01J0DEADSPACE0000000000001";
    const SPACE_KEEP_2910: &str = "01J0KEEPSPACE0000000000002";
    const CHILD_PURGE_2910: &str = "01J0DEADSPACEXYZ0000000001";

    /// Seed a REGISTERED space: its own soft-deleted page block (own
    /// `space_id` NULL, exactly as production — a space carries
    /// `is_space="true"`, never `space=<self>`), a `spaces` registry row
    /// (production writes this via the `is_space` -> 0089 trigger), and one
    /// live content child that belongs to it.
    async fn seed_registered_space(pool: &SqlitePool, space: &str, child: &str) {
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, deleted_at, space_id) \
             VALUES (?, 'page', 'Dead Space', NULL, 1, ?, ?, NULL)",
        )
        .bind(space)
        .bind(space)
        .bind(now_ms())
        .execute(pool)
        .await
        .expect("seed space block");
        sqlx::query("INSERT INTO spaces (id) VALUES (?)")
            .bind(space)
            .execute(pool)
            .await
            .expect("register space");
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'child of dead space', ?, 1, ?, ?)",
        )
        .bind(child)
        .bind(space)
        .bind(space)
        .bind(space)
        .execute(pool)
        .await
        .expect("seed child block");
    }

    /// Register a live engine for `space` (marks it dirty) and persist a
    /// `loro_doc_state` snapshot row for it. The registry engine and the
    /// persisted row are the two things #2910 must tear down.
    async fn register_engine_and_snapshot(
        pool: &SqlitePool,
        state: &crate::loro::shared::LoroState,
        space: &SpaceId,
        block: &str,
    ) {
        // `for_space` marks the space dirty; scope the (non-Send parking_lot)
        // guard so it never crosses an `.await`.
        {
            let mut g = state
                .registry
                .for_space(space, "device-1")
                .expect("for_space");
            g.engine_mut()
                .apply_create_block(block, "content", "content", None, 0)
                .expect("create block in engine");
        }
        let mut e = LoroEngine::with_peer_id("device-1").expect("engine");
        e.apply_create_block(block, "content", "content", None, 0)
            .expect("create block for snapshot");
        save_snapshot(pool, space, &e).await.expect("save snapshot");
    }

    /// Row-gone + engine-evicted. Reverting the cascade's
    /// `DELETE FROM loro_doc_state` resurrects the row (first assert fails);
    /// reverting the `registry.evict_space` call keeps the engine (second
    /// assert fails). The KEEP space proves the teardown is scoped to the
    /// purged space, not a blanket wipe.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_registered_space_deletes_snapshot_and_evicts_engine_2910() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        let purge = SpaceId::from_trusted(SPACE_PURGE_2910);
        let keep = SpaceId::from_trusted(SPACE_KEEP_2910);

        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        register_engine_and_snapshot(&pool, &state, &purge, "BLK_DOOMED").await;
        register_engine_and_snapshot(&pool, &state, &keep, "BLK_ALIVE").await;

        // Pre-conditions: both spaces have a persisted row and a live engine.
        assert!(
            load_snapshot(&pool, &purge).await.unwrap().is_some(),
            "seed: purged space must have a loro_doc_state row"
        );
        assert!(
            state.registry.space_ids().contains(&purge),
            "seed: purged space must have a registered engine"
        );

        // Purge the space's page block through the materialization chokepoint,
        // inside a tx so the cascade's deferred-FK behaviour matches production.
        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        // The purged space's snapshot row is GONE (only my explicit
        // `DELETE FROM loro_doc_state` can remove it — the table has no FK).
        assert!(
            load_snapshot(&pool, &purge).await.unwrap().is_none(),
            "#2910: the purged space's loro_doc_state row must be deleted by the cascade"
        );
        // The purged space's in-memory engine is EVICTED.
        assert!(
            !state.registry.space_ids().contains(&purge),
            "#2910: the purged space's engine must be evicted from the registry"
        );
        // The unrelated live space is untouched — row and engine both survive.
        assert!(
            load_snapshot(&pool, &keep).await.unwrap().is_some(),
            "#2910: an unrelated space's snapshot row must survive the purge"
        );
        assert!(
            state.registry.space_ids().contains(&keep),
            "#2910: an unrelated space's engine must survive the purge"
        );
    }

    /// #5841 — purging a space removes its property definitions and only
    /// its: they are keyed by `space_id` with no FK, so nothing else would.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_registered_space_deletes_its_property_definitions_5841() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        for space in [SPACE_PURGE_2910, SPACE_KEEP_2910] {
            sqlx::query(
                "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
                 VALUES (?, 'stage', 'text', 'T')",
            )
            .bind(space)
            .execute(&pool)
            .await
            .expect("seed a definition");
        }

        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        let left: Vec<String> =
            sqlx::query_scalar("SELECT space_id FROM property_definitions ORDER BY space_id")
                .fetch_all(&pool)
                .await
                .expect("read definitions");
        assert_eq!(
            left,
            [SPACE_KEEP_2910],
            "the purged space's definitions go, another space's stay"
        );
    }

    /// Boot-residue regression guard: after purging the space, a fresh boot
    /// rehydration (`rehydrate_registry`, which reinstalls an engine for
    /// EVERY persisted `loro_doc_state` row) must NOT resurrect the dead
    /// space. If the cascade `DELETE FROM loro_doc_state` were reverted, the
    /// stale row would survive the purge and rehydrate here — this test fails.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purged_space_is_not_rehydrated_at_next_boot_2910() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        let purge = SpaceId::from_trusted(SPACE_PURGE_2910);
        let keep = SpaceId::from_trusted(SPACE_KEEP_2910);

        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        register_engine_and_snapshot(&pool, &state, &purge, "BLK_DOOMED").await;
        register_engine_and_snapshot(&pool, &state, &keep, "BLK_ALIVE").await;

        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        // Simulate a fresh process boot: rehydrate a brand-new registry
        // strictly from whatever `loro_doc_state` now holds.
        let booted = LoroEngineRegistry::new();
        let n = rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            n, 1,
            "#2910: only the surviving space must rehydrate at boot (the purged \
             space's row is gone)"
        );
        assert!(
            !booted.space_ids().contains(&purge),
            "#2910: the purged (dead) space must NOT be reinstalled at boot"
        );
        assert!(
            booted.space_ids().contains(&keep),
            "the surviving space must still rehydrate at boot"
        );
    }

    /// Whether `space`'s saved row holds `block`.
    async fn saved_row_holds(pool: &SqlitePool, space: &SpaceId, block: &str) -> bool {
        let bytes = load_snapshot(pool, space)
            .await
            .expect("load")
            .expect("row");
        let mut saved = LoroEngine::with_peer_id("device-1").expect("engine");
        saved.import(&bytes).expect("import");
        saved.read_block(block).expect("read").is_some()
    }

    /// #6521 — a pass can export an engine while a transaction's write sits in
    /// it uncommitted. When that transaction rolls back, the engine is
    /// rewound, and the row the pass wrote holds a block that SQL, the op log
    /// and the engine do not. The rewind marks the space dirty, so the next
    /// pass writes the engine as it now is.
    #[tokio::test]
    async fn a_pass_that_saved_a_write_which_then_rolled_back_is_saved_over_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let state = crate::loro::shared::LoroState::new();

        let scope = crate::loro::revert::RevertScope::arm(&state);
        state
            .registry
            .for_space_recording(&space, "device-1", &state.revert)
            .expect("engine")
            .engine_mut()
            .apply_create_block("ROLLED_BACK", "content", "never committed", None, 0)
            .expect("create");
        assert_eq!(
            save_all_engines(&pool, &state.registry).await.saved,
            1,
            "the pass runs while the transaction is open"
        );
        assert!(
            saved_row_holds(&pool, &space, "ROLLED_BACK").await,
            "the fixture: the pass exported the uncommitted write"
        );
        scope.detach().revert();

        save_all_engines(&pool, &state.registry).await;

        assert!(
            !saved_row_holds(&pool, &space, "ROLLED_BACK").await,
            "the saved row must not keep a write its transaction rolled back"
        );
        assert_eq!(
            state.registry.dirty_count(),
            0,
            "and the space is clean once the rewound engine is saved"
        );
    }

    /// #6521 — a pass started while another is in flight waits for it.
    /// `mirror_sql_tombstones_onto_engine` and the one-time hydration call
    /// [`save_all_engines`] themselves; a pass that had already exported a
    /// space could otherwise write its row after theirs, leaving a row older
    /// than its engine in a space that reads clean.
    ///
    /// The pass in flight is played by this test, holding the lock around a
    /// pass's own steps: nothing outside a pass can park it between its export
    /// and its write. The bounded wait is the time the second pass gets to run
    /// to its end when nothing makes it wait.
    #[tokio::test]
    async fn a_pass_started_during_another_waits_for_it_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let registry = LoroEngineRegistry::new();
        let create = |block: &str| {
            registry
                .for_space(&space, "device-1")
                .expect("engine")
                .engine_mut()
                .apply_create_block(block, "content", block, None, 0)
                .expect("create");
        };
        create("OLDER");

        let in_flight = ONE_PASS_AT_A_TIME.lock().await;
        let exported = registry.snapshot_dirty_engines();
        create("NEWER");
        let second = save_all_engines(&pool, &registry);
        tokio::pin!(second);
        let ran_at_once = tokio::time::timeout(std::time::Duration::from_millis(250), &mut second)
            .await
            .is_ok();
        for (space_id, mark_stamp, bytes) in exported {
            write_snapshot_row(&pool, &space_id, bytes.expect("export"), 0)
                .await
                .expect("write");
            registry.clear_dirty_if_unchanged(&space_id, mark_stamp);
        }
        drop(in_flight);
        if !ran_at_once {
            second.await;
        }

        assert!(
            saved_row_holds(&pool, &space, "NEWER").await,
            "the saved row must hold what the later pass exported"
        );
        assert_eq!(
            registry.dirty_count(),
            0,
            "and the space is clean with its newest state saved"
        );
    }
}
